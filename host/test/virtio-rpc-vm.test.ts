import assert from "node:assert/strict";
import test from "node:test";
import { decode } from "cbor2";
import { VM } from "../src/vm/core.ts";
import { encodeFrame } from "../src/sandbox/virtio-protocol.ts";
import { shouldSkipVmTests } from "./helpers/vm-fixture.ts";

// No guest dependencies: only Node built-ins and a host-encoded CBOR request.
const guestClient = `
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const wait = new Int32Array(new SharedArrayBuffer(4));
const deadline = performance.now() + 5000;
let fd;
while (fd === undefined && performance.now() < deadline) {
  let ports = [];
  try { ports = fs.readdirSync('/sys/class/virtio-ports'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const port of ports) {
    if (!/^vport[0-9]+p[0-9]+$/.test(port)) continue;
    try {
      const name = fs.readFileSync('/sys/class/virtio-ports/' + port + '/name', 'utf8');
      if (name.trim() !== 'virtio-rpc') continue;
      const device = '/dev/' + port;
      if (!fs.statSync(device).isCharacterDevice()) throw new Error('Not a character device');
      fd = fs.openSync(device, 'r+');
      console.error('RPC device: ' + device);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENODEV') throw error;
    }
  }
  if (fd === undefined) Atomics.wait(wait, 0, 0, 25);
}
if (fd === undefined) throw new Error('RPC device not found within 5000 ms');
function readExactly(length) {
  const b = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const n = fs.readSync(fd, b, offset, length - offset, null);
    if (!n) throw new Error('RPC port closed');
    offset += n;
  }
  return b;
}
try {
  const frame = Buffer.from(process.argv[1], 'base64');
  let offset = 0;
  while (offset < frame.length) {
    const n = fs.writeSync(fd, frame, offset, frame.length - offset);
    if (!n) throw new Error('RPC write failed');
    offset += n;
  }
  const size = readExactly(4).readUInt32BE();
  if (size > 66560) throw new Error('RPC response too large');
  process.stdout.write(readExactly(size).toString('base64'));
} finally { fs.closeSync(fd); }
`;

test("virtio RPC: real guest reaches only its per-VM host callback without networking", {
  skip: shouldSkipVmTests(),
  timeout: 60000,
}, async () => {
  const calls: string[] = [];
  const vm = await VM.create({
    sandbox: {
      vmm: "qemu",
      console: "none",
      netEnabled: false,
      rpcChannel: {
        handler: async ({ channel, payload }) => {
          calls.push(channel);
          return `host:${payload}`;
        },
      },
    },
    vfs: null,
    env: {},
    startTimeoutMs: 30000,
  });
  try {
    // Reproduce fresh images without a udev-created named-port symlink.
    const setup = await vm.exec(
      [
        "/usr/bin/node",
        "-e",
        `
const fs = require('node:fs');
const link = '/dev/virtio-ports/virtio-rpc';
try {
  if (!fs.lstatSync(link).isSymbolicLink()) throw new Error('Not a symlink');
  fs.unlinkSync(link);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
if (fs.existsSync(link)) throw new Error('Named RPC path still exists');
`,
      ],
      { signal: AbortSignal.timeout(5000) },
    );
    assert.equal(setup.exitCode, 0, setup.stderr);
    const frame = encodeFrame({
      v: 1,
      t: "rpc_request",
      id: 1,
      p: { channel: "tools", payload: "guest-smoke" },
    });
    const result = await vm.exec(
      ["/usr/bin/node", "-e", guestClient, frame.toString("base64")],
      { signal: AbortSignal.timeout(20000) },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stderr, /RPC device: \/dev\/vport[0-9]+p[0-9]+/);
    assert.deepEqual(decode(Buffer.from(result.stdout, "base64")), {
      v: 1,
      t: "rpc_response",
      id: 1,
      p: { channel: "tools", ok: true, payload: "host:guest-smoke" },
    });
    assert.deepEqual(calls, ["tools"]);
  } finally {
    await vm.close();
  }
});

test("virtio RPC: guest discovery times out when no RPC device is configured", {
  skip: shouldSkipVmTests(),
  timeout: 60000,
}, async () => {
  const vm = await VM.create({
    sandbox: { vmm: "qemu", console: "none", netEnabled: false },
    vfs: null,
    env: {},
    startTimeoutMs: 30000,
  });
  try {
    const result = await vm.exec(["/usr/bin/node", "-e", guestClient], {
      signal: AbortSignal.timeout(20000),
    });
    assert.equal(result.exitCode, 1, result.stderr);
    assert.match(result.stderr, /RPC device not found within 5000 ms/);
    assert.equal(result.stdout, "");
  } finally {
    await vm.close();
  }
});
