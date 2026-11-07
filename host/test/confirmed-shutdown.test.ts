import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import childProcess, { type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test, { afterEach, mock } from "node:test";

import {
  getActiveChildrenCount,
  terminateChild,
  trackChild,
} from "../src/sandbox/child-process.ts";
import { SandboxController } from "../src/sandbox/controller.ts";
import { KrunController } from "../src/sandbox/krun-controller.ts";

class FakeChild extends EventEmitter {
  pid: number | undefined = 12345;
  exitCode: number | null = null;
  signalCode: string | null = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: string[] = [];
  detached = false;
  kill(signal: string) {
    this.signals.push(signal);
    return true;
  }
  unref() {
    this.detached = true;
  }
  exit() {
    this.exitCode = 0;
    this.emit("exit", 0, null);
  }
}
const children: FakeChild[] = [];
const roots: string[] = [];
function child() {
  const value = new FakeChild();
  children.push(value);
  return value;
}
function asProcess(value: FakeChild) {
  return value as unknown as ChildProcess;
}
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
afterEach(() => {
  for (const value of children.splice(0)) value.exit();
  mock.restoreAll();
  mock.timers.reset();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("termination deadline rejects instead of certifying a detached process", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const owned = child();
  const other = child();
  trackChild(asProcess(owned));
  trackChild(asProcess(other));
  const closing = terminateChild(asProcess(owned));
  const rejected = assert.rejects(closing, /termination not confirmed/);
  mock.timers.tick(10_000);
  await rejected;
  assert.equal(owned.detached, true);
  assert.ok(owned.signals.includes("SIGKILL"));
  assert.deepEqual(other.signals, []);
  assert.equal(getActiveChildrenCount(), 2);
  assert.equal(owned.listenerCount("error"), 1); // Only the tracking listener remains.
});

test("an error from a spawned process neither confirms exit nor drops tracking", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const owned = child();
  trackChild(asProcess(owned));
  const closing = terminateChild(asProcess(owned));
  let settled = false;
  void closing.then(() => {
    settled = true;
  });
  owned.emit("error", new Error("kill failed: private details"));
  await flush();
  const beforeExit = { settled, count: getActiveChildrenCount() };
  owned.exit();
  await closing;
  assert.deepEqual(beforeExit, { settled: false, count: 1 });
  assert.equal(getActiveChildrenCount(), 0);
});

test("a failed spawn with no PID is not an active runner", async () => {
  const owned = child();
  owned.pid = undefined;
  trackChild(asProcess(owned));
  const closing = terminateChild(asProcess(owned));
  owned.emit("error", new Error("spawn failed"));
  await closing;
  assert.equal(getActiveChildrenCount(), 0);
  assert.equal(owned.listenerCount("exit"), 0);
});

test("already observed signal termination does not signal a stale PID", async () => {
  const owned = child();
  owned.signalCode = "SIGKILL";
  const closing = terminateChild(asProcess(owned));
  const signalsBeforeExit = [...owned.signals];
  owned.exit();
  await closing;
  assert.deepEqual(signalsBeforeExit, []);
});

test("confirmed exit removes termination listeners without waiting for the deadline", async () => {
  const owned = child();
  const closing = terminateChild(asProcess(owned));
  owned.exit();
  await closing;
  assert.equal(owned.listenerCount("exit"), 0);
  assert.equal(owned.listenerCount("error"), 0);
  assert.deepEqual(owned.signals, ["SIGTERM"]);
});

for (const invalid of [0, -1, NaN, Infinity, 1.5, 300_001]) {
  test(`invalid termination deadline ${invalid} fails before signaling`, async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const owned = child();
    const rejected = assert.rejects(
      terminateChild(asProcess(owned), { closeTimeoutMs: invalid }),
      /Invalid.*termination/,
    );
    mock.timers.tick(300_001);
    await rejected;
    assert.deepEqual(owned.signals, []);
  });
}

function controllerFixture(backend: "qemu" | "krun", autoRestart = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-shutdown-"));
  roots.push(root);
  mock.method(os, "tmpdir", () => root);
  // No codesign or VMM executable is run, including on macOS.
  mock.method(
    childProcess,
    "execFileSync",
    () => "com.apple.security.hypervisor",
  );
  const owned = child();
  const spawn = mock.method(childProcess, "spawn", () => asProcess(owned));
  const config = {
    qemuPath: "mock-qemu",
    krunRunnerPath: "/mock-krun",
    kernelPath: path.join(root, "kernel"),
    initrdPath: path.join(root, "initrd"),
    memory: "256M",
    cpus: 1,
    virtioSocketPath: path.join(root, "control.sock"),
    virtioFsSocketPath: path.join(root, "fs.sock"),
    virtioSshSocketPath: path.join(root, "ssh.sock"),
    virtioIngressSocketPath: path.join(root, "ingress.sock"),
    append: "console=ttyS0",
    autoRestart,
  };
  const controller =
    backend === "qemu"
      ? new SandboxController(config)
      : new KrunController(config);
  return { controller, owned, spawn, root };
}
for (const backend of ["qemu", "krun"] as const) {
  test(`${backend}: concurrent close owns one shutdown until actual exit`, async () => {
    const { controller, owned } = controllerFixture(backend);
    await controller.start();
    owned.emit("spawn");
    const closing = controller.close();
    const concurrent = controller.close();
    const pidWhileClosing = controller.getHostPid();
    const samePromise = concurrent === closing;
    owned.exit();
    await Promise.all([closing, concurrent]);
    assert.equal(pidWhileClosing, owned.pid);
    assert.equal(samePromise, true);
    assert.deepEqual(owned.signals, ["SIGTERM"]);
    assert.equal(controller.getHostPid(), null);
  });

  test(`${backend}: timeout remains failed after repeated close and late exit`, async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { controller, owned, root } = controllerFixture(backend);
    await controller.start();
    owned.emit("spawn");
    const closing = controller.close();
    const rejected = assert.rejects(closing, /termination not confirmed/);
    mock.timers.tick(10_000);
    await rejected;
    assert.equal(controller.getHostPid(), owned.pid);
    assert.notEqual(controller.getState(), "stopped");
    await assert.rejects(controller.close(), /termination not confirmed/);
    await assert.rejects(controller.start(), /shutdown incomplete/);
    if (backend === "krun") assert.equal(fs.readdirSync(root).length, 1);
    owned.exit();
    await assert.rejects(controller.close(), /termination not confirmed/);
    await assert.rejects(controller.start(), /shutdown incomplete/);
  });

  test(`${backend}: a post-spawn error retains ownership until exit`, async () => {
    const { controller, owned } = controllerFixture(backend);
    await controller.start();
    owned.emit("spawn");
    owned.emit("error", new Error("kill failed: private details"));
    const observed = {
      pid: controller.getHostPid(),
      state: controller.getState(),
      tracked: getActiveChildrenCount(),
    };
    const closing = controller.close();
    owned.exit();
    await closing;
    assert.deepEqual(observed, {
      pid: owned.pid,
      state: "running",
      tracked: 1,
    });
    assert.deepEqual(owned.signals, ["SIGTERM"]);
  });

  test(`${backend}: start cannot race a pending shutdown`, async () => {
    const { controller, owned, spawn } = controllerFixture(backend);
    await controller.start();
    owned.emit("spawn");
    const closing = controller.close();
    const restart = assert.rejects(controller.start(), /shutdown incomplete/);
    owned.exit();
    await Promise.all([closing, restart]);
    assert.equal(spawn.mock.callCount(), 1);
  });

  test(`${backend}: close cancels a crash restart even with no current child`, async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { controller, owned, spawn } = controllerFixture(backend, true);
    await controller.start();
    owned.emit("spawn");
    owned.exit();
    await controller.close();
    mock.timers.tick(2000);
    await flush();
    assert.equal(spawn.mock.callCount(), 1);
  });

  test(`${backend}: explicit restart after confirmed close remains supported`, async () => {
    const { controller, owned, spawn } = controllerFixture(backend);
    await controller.start();
    const closing = controller.close();
    owned.exit();
    await closing;
    await controller.start();
    assert.equal(spawn.mock.callCount(), 2);
    const secondClose = controller.close();
    owned.exit();
    await secondClose;
  });
}
