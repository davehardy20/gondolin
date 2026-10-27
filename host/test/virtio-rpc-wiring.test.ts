import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { __test, type SandboxConfig } from "../src/sandbox/controller.ts";
import { resolveSandboxServerOptions } from "../src/sandbox/server-options.ts";
import { createRpcSocketPath, RpcChannel } from "../src/sandbox/rpc-channel.ts";

function config(): SandboxConfig {
  return {
    qemuPath: "qemu-system-aarch64",
    kernelPath: "/tmp/kernel",
    initrdPath: "/tmp/initrd",
    memory: "256M",
    cpus: 1,
    virtioSocketPath: "/tmp/control.sock",
    virtioFsSocketPath: "/tmp/fs.sock",
    virtioSshSocketPath: "/tmp/ssh.sock",
    virtioIngressSocketPath: "/tmp/ingress.sock",
    append: "console=ttyAMA0",
    machineType: "virt",
    accel: "tcg",
    console: "none",
    autoRestart: false,
  };
}

test("virtio RPC is opt-in and isolated from the existing QEMU ports", () => {
  assert.ok(!__test.buildQemuArgs(config()).join(" ").includes("virtio-rpc"));
  const args = __test.buildQemuArgs(
    Object.assign(config(), {
      virtioRpcSocketPath: "/tmp/rpc/channel.sock",
    }),
  );
  assert.ok(
    args.includes("socket,id=virtiorpc0,path=/tmp/rpc/channel.sock,server=off"),
  );
  assert.ok(
    args.includes(
      "virtserialport,chardev=virtiorpc0,name=virtio-rpc,bus=virtio-serial0.0",
    ),
  );
  assert.ok(
    args.includes(
      "virtserialport,chardev=virtiocon0,name=virtio-port,bus=virtio-serial0.0",
    ),
  );
});

test("virtio RPC escapes commas in QEMU chardev option values", () => {
  const args = __test.buildQemuArgs({
    ...config(),
    virtioRpcSocketPath: "/tmp/rpc,private/channel.sock",
  });
  assert.ok(
    args.includes(
      "socket,id=virtiorpc0,path=/tmp/rpc,,private/channel.sock,server=off",
    ),
  );
});

for (const relative of [false, true]) {
  const name = relative ? "relative" : "60-byte";
  test(`virtio RPC binds successfully with a valid ${name} Linux TMPDIR`, async (t) => {
    const root = fs.mkdtempSync("/tmp/g-rpc-assets-");
    const tmpDir = relative
      ? path.relative(process.cwd(), root)
      : path.join(root, "t".repeat(60 - Buffer.byteLength(root) - 1));
    if (!relative) fs.mkdirSync(tmpDir);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    let channel: RpcChannel | undefined;
    let socket: net.Socket | undefined;
    try {
      const imagePath = {
        kernelPath: path.join(root, "kernel"),
        initrdPath: path.join(root, "initrd"),
        rootfsPath: path.join(root, "rootfs.ext4"),
      };
      for (const file of Object.values(imagePath)) fs.writeFileSync(file, "");
      t.mock.method(os, "tmpdir", () => tmpDir);
      Object.defineProperty(process, "platform", { value: "linux" });
      const options = resolveSandboxServerOptions({
        vmm: "qemu",
        imagePath,
        netEnabled: false,
        rpcChannel: { handler: async () => "ok" },
      });
      Object.defineProperty(process, "platform", platform);
      if (relative) assert.equal(path.isAbsolute(tmpDir), false);
      else assert.equal(Buffer.byteLength(tmpDir), 60);
      assert.ok(Buffer.byteLength(options.virtioIngressSocketPath) <= 103);
      assert.ok(Buffer.byteLength(options.virtioRpcSocketPath!) <= 103);
      assert.equal(
        path.dirname(path.dirname(options.virtioRpcSocketPath!)),
        path.resolve(tmpDir),
      );
      channel = new RpcChannel(
        options.virtioRpcSocketPath!,
        options.rpcChannel!,
      );
      channel.connect();
      socket = net.createConnection(channel.socketPath);
      await once(socket, "connect", { signal: AbortSignal.timeout(1000) });
      assert.equal(
        fs.statSync(path.dirname(channel.socketPath)).mode & 0o777,
        0o700,
      );
    } finally {
      Object.defineProperty(process, "platform", platform);
      t.mock.restoreAll();
      socket?.destroy();
      await channel?.close();
      if (channel)
        assert.equal(fs.existsSync(path.dirname(channel.socketPath)), false);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const tmpDir of [".", "tmp/nested", "./tmp/./nested"]) {
  test(`virtio RPC resolves temporary parent ${tmpDir} before validation`, () => {
    const socketPath = createRpcSocketPath(tmpDir);
    const parent = path.resolve(tmpDir);
    const candidate = path.join(parent, `g-rpc-${"0".repeat(32)}`, "s");
    assert.equal(
      path.dirname(path.dirname(socketPath)),
      Buffer.byteLength(candidate) <= 103 ? parent : "/tmp",
    );
    assert.equal(path.isAbsolute(socketPath), true);
    assert.ok(Buffer.byteLength(socketPath) <= 103);
  });
}

test("virtio RPC checks the byte limit after resolving a relative parent", () => {
  const tmpDir = "x".repeat(62);
  const relative = path.join(tmpDir, `g-rpc-${"0".repeat(32)}`, "s");
  assert.equal(Buffer.byteLength(relative), 103);
  assert.ok(Buffer.byteLength(path.resolve(relative)) > 103);
  const socketPath = createRpcSocketPath(tmpDir);
  assert.equal(path.dirname(path.dirname(socketPath)), "/tmp");
  assert.ok(Buffer.byteLength(socketPath) <= 103);
});

test("virtio RPC keeps TMPDIR at the byte limit without shortening UUID entropy", () => {
  const tmpDir = `/tmp/${"x".repeat(57)}`;
  const socketPath = createRpcSocketPath(tmpDir);
  assert.equal(Buffer.byteLength(socketPath), 103);
  assert.equal(path.dirname(path.dirname(socketPath)), tmpDir);
  assert.match(path.basename(path.dirname(socketPath)), /^g-rpc-[0-9a-f]{32}$/);
  assert.notEqual(createRpcSocketPath(tmpDir), socketPath);
});

for (const [name, tmpDir] of [
  ["ASCII", `/tmp/${"x".repeat(58)}`],
  ["UTF-8", `/tmp/${"é".repeat(30)}`],
]) {
  test(`virtio RPC binds under /tmp when ${name} TMPDIR exceeds the byte limit`, async () => {
    const socketPath = createRpcSocketPath(tmpDir!);
    assert.equal(path.dirname(path.dirname(socketPath)), "/tmp");
    assert.ok(Buffer.byteLength(socketPath) <= 103);
    const channel = new RpcChannel(socketPath, { handler: async () => "ok" });
    let socket: net.Socket | undefined;
    try {
      channel.connect();
      socket = net.createConnection(socketPath);
      await once(socket, "connect", { signal: AbortSignal.timeout(1000) });
      assert.equal(fs.statSync(path.dirname(socketPath)).mode & 0o777, 0o700);
    } finally {
      socket?.destroy();
      await channel.close();
    }
    assert.equal(fs.existsSync(path.dirname(socketPath)), false);
  });
}

for (const [name, socketPath] of [
  ["overlong ASCII", `/tmp/${"x".repeat(97)}/s`],
  ["overlong UTF-8", `/tmp/${"é".repeat(60)}/s`],
  ["relative", "rpc/channel.sock"],
  ["traversal", "/tmp/../rpc/channel.sock"],
  ["embedded NUL", "/tmp/rpc\0/channel.sock"],
]) {
  test(`virtio RPC rejects ${name} paths before creating directories`, () => {
    assert.throws(
      () => new RpcChannel(socketPath!, { handler: async () => "ok" }),
      /RPC socket path/,
    );
  });
}

test("virtio RPC accepts the portable 103-byte path boundary", () => {
  const socketPath = `/tmp/${"x".repeat(96)}/s`;
  assert.equal(Buffer.byteLength(socketPath), 103);
  assert.doesNotThrow(
    () => new RpcChannel(socketPath, { handler: async () => "ok" }),
  );
});

test("virtio RPC refuses krun instead of silently dropping the channel", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-rpc-assets-"));
  try {
    const imagePath = {
      kernelPath: path.join(dir, "kernel"),
      initrdPath: path.join(dir, "initrd"),
      rootfsPath: path.join(dir, "rootfs.ext4"),
    };
    for (const file of Object.values(imagePath)) fs.writeFileSync(file, "");
    const options = Object.assign(
      { vmm: "krun" as const, imagePath },
      { rpcChannel: { handler: async () => "ok" } },
    );
    assert.throws(
      () =>
        resolveSandboxServerOptions(options, undefined, {
          resolveDefaultKrunRunnerPath: () => "/bin/true",
        }),
      /rpcChannel.*qemu/i,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
