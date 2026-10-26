import assert from "node:assert/strict";
import test from "node:test";
import { decode } from "cbor2";
import { VM } from "../src/vm/core.ts";
import { encodeFrame } from "../src/sandbox/virtio-protocol.ts";
import { shouldSkipVmTests } from "./helpers/vm-fixture.ts";

// No guest dependencies: only Node built-ins and a host-encoded CBOR request.
const guestClient = `
const fs = require('node:fs');
const fd = fs.openSync('/dev/virtio-ports/virtio-rpc', 'r+');
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
