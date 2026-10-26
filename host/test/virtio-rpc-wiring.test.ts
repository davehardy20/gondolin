import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { __test, type SandboxConfig } from "../src/sandbox/controller.ts";
import { resolveSandboxServerOptions } from "../src/sandbox/server-options.ts";

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
