import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { encode } from "cbor2";
import {
  MAX_RPC_PAYLOAD_BYTES,
  RpcChannel,
  type RpcChannelOptions,
} from "../src/sandbox/rpc-channel.ts";
import {
  decodeMessage,
  encodeFrame,
  FrameReader,
} from "../src/sandbox/virtio-protocol.ts";

type Reply = {
  id: number;
  p: { ok: boolean; payload?: string; error?: string };
};

async function peer(options: RpcChannelOptions) {
  const dir = path.join("/tmp", `gondolin-rpc-test-${randomUUID()}`);
  const channel = new RpcChannel(path.join(dir, "channel.sock"), options);
  channel.connect();
  const socket = net.createConnection(channel.socketPath);
  await once(socket, "connect");
  const reader = new FrameReader();
  const replies: Reply[] = [];
  const ready = new EventEmitter();
  socket.on("data", (data) => {
    reader.push(data, (frame) => {
      replies.push(decodeMessage(frame) as unknown as Reply);
      ready.emit("reply");
    });
  });
  return {
    channel,
    socket,
    dir,
    send(id: number, payload = "hello", name = "tools") {
      socket.write(
        encodeFrame({
          v: 1,
          t: "rpc_request",
          id,
          p: { channel: name, payload },
        }),
      );
    },
    async reply(): Promise<Reply> {
      if (!replies.length) {
        await once(ready, "reply", { signal: AbortSignal.timeout(1000) });
      }
      return replies.shift()!;
    },
    async close() {
      socket.destroy();
      await channel.close();
    },
  };
}

test("RPC round trip uses a private directory and returns only the opaque message", async () => {
  const p = await peer({
    handler: async ({ channel, payload }) => `${channel}:${payload}`,
  });
  try {
    assert.equal(fs.statSync(p.dir).mode & 0o777, 0o700);
    p.send(1);
    assert.deepEqual(await p.reply(), {
      v: 1,
      t: "rpc_response",
      id: 1,
      p: { channel: "tools", ok: true, payload: "tools:hello" },
    });
  } finally {
    await p.close();
  }
  assert.equal(fs.existsSync(p.dir), false);
});

for (const message of [
  { v: 1, t: "exec_request", id: 1, p: {} },
  { v: 2, t: "rpc_request", id: 1, p: { channel: "tools", payload: "x" } },
  { v: 1, t: "rpc_request", id: 0, p: { channel: "tools", payload: "x" } },
  { v: 1, t: "rpc_request", id: 1, p: { channel: "../tools", payload: "x" } },
  { v: 1, t: "rpc_request", id: 1, p: { channel: "tools", payload: {} } },
  {
    v: 1,
    t: "rpc_request",
    id: 1,
    p: { channel: "tools", payload: "x", command: "sh" },
  },
]) {
  test(`RPC rejects malformed or control-plane message ${JSON.stringify(message)}`, async () => {
    let calls = 0;
    const p = await peer({
      handler: async () => {
        calls++;
        return "bad";
      },
    });
    try {
      const closed = once(p.socket, "close");
      p.socket.write(encodeFrame(message));
      await closed;
      assert.equal(calls, 0);
    } finally {
      await p.close();
    }
  });
}

test("RPC payload cap counts UTF-8 bytes", async () => {
  const p = await peer({ handler: async ({ payload }) => payload });
  try {
    p.send(1, "é".repeat(MAX_RPC_PAYLOAD_BYTES / 2));
    assert.equal((await p.reply()).p.ok, true);
    const closed = once(p.socket, "close");
    p.send(2, "é".repeat(MAX_RPC_PAYLOAD_BYTES / 2 + 1));
    await closed;
  } finally {
    await p.close();
  }
});

test("RPC hides handler errors and refuses oversized responses", async () => {
  const p = await peer({
    handler: async ({ payload }) => {
      if (payload === "throw") throw new Error("private-host-secret");
      return "x".repeat(MAX_RPC_PAYLOAD_BYTES + 1);
    },
  });
  try {
    p.send(1, "throw");
    const error = await p.reply();
    assert.equal(error.p.error, "handler_failed");
    assert.ok(!JSON.stringify(error).includes("private-host-secret"));
    p.send(2, "large");
    assert.equal((await p.reply()).p.error, "invalid_response");
  } finally {
    await p.close();
  }
});

test("RPC timeout aborts but never frees a slot for an uncooperative handler", async () => {
  let signal: AbortSignal | undefined;
  let release!: (result: string) => void;
  let calls = 0;
  const p = await peer({
    timeoutMs: 15,
    maxConcurrent: 1,
    handler: async (request) => {
      signal = request.signal;
      if (++calls > 1) return "next";
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    },
  });
  try {
    p.send(1);
    assert.equal((await p.reply()).p.error, "timeout");
    assert.equal(signal?.aborted, true);
    p.send(2);
    assert.equal((await p.reply()).p.error, "busy");
    release("late-result");
    await setImmediate();
    p.send(3);
    const next = await p.reply();
    assert.equal(next.id, 3);
    assert.equal(next.p.payload, "next");
  } finally {
    release("late-result");
    await p.close();
  }
});

test("RPC rejects replay and cancels the pending handler on disconnect", async () => {
  const started = Promise.withResolvers<AbortSignal>();
  const p = await peer({
    handler: async ({ signal }) => {
      started.resolve(signal);
      return new Promise<string>(() => {});
    },
  });
  try {
    p.send(1);
    const signal = await started.promise;
    const closed = once(p.socket, "close");
    p.send(1);
    await closed;
    assert.equal(signal.aborted, true);
  } finally {
    await p.close();
  }
});

test("RPC shutdown aborts in-flight callbacks without awaiting their cooperation", async () => {
  const started = Promise.withResolvers<AbortSignal>();
  const p = await peer({
    handler: async ({ signal }) => {
      started.resolve(signal);
      return new Promise<string>(() => {});
    },
  });
  p.send(1);
  const signal = await started.promise;
  await p.close();
  assert.equal(signal.aborted, true);
  assert.equal(fs.existsSync(p.dir), false);
});

// Encode deliberately non-canonical maps that a normal encoder cannot produce.
function rawMap(entries: [string, string | number | Buffer][]): Buffer {
  return Buffer.concat([
    Buffer.from([0xa0 + entries.length]),
    ...entries.flatMap(([key, value]) => [
      encode(key),
      Buffer.isBuffer(value) ? value : encode(value),
    ]),
  ]);
}

const validFields: [string, string | number | Buffer][] = [
  ["v", 1],
  ["t", "rpc_request"],
  ["id", 1],
];
const validParams = rawMap([
  ["channel", "tools"],
  ["payload", "x"],
]);
for (const [name, body] of [
  [
    "duplicate root key",
    rawMap([...validFields, ["p", validParams], ["v", 1]]),
  ],
  [
    "duplicate payload key",
    rawMap([
      ...validFields,
      [
        "p",
        rawMap([
          ["channel", "tools"],
          ["payload", "x"],
          ["payload", "y"],
        ]),
      ],
    ]),
  ],
  [
    "excess nesting",
    rawMap([
      ...validFields,
      [
        "p",
        rawMap([
          ["channel", "tools"],
          [
            "payload",
            Buffer.concat([Buffer.alloc(10000, 0x81), Buffer.from([0])]),
          ],
        ]),
      ],
    ]),
  ],
  [
    "alternate encoding of duplicate id key",
    Buffer.concat([
      Buffer.from([0xa5]),
      rawMap([...validFields, ["p", validParams]]).subarray(1),
      Buffer.from("7802696401", "hex"),
    ]),
  ],
  [
    "alternate encoding of duplicate payload key",
    rawMap([
      ...validFields,
      [
        "p",
        Buffer.concat([
          Buffer.from([0xa3]),
          validParams.subarray(1),
          Buffer.from([0x78, 7]),
          Buffer.from("payload"),
          encode("y"),
        ]),
      ],
    ]),
  ],
  ["malformed CBOR", Buffer.from([0xff])],
] as const) {
  test(`RPC rejects ${name} before invoking any host callback`, async () => {
    let calls = 0;
    const p = await peer({
      handler: async () => {
        calls++;
        return "bad";
      },
    });
    try {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length);
      const closed = once(p.socket, "close", {
        signal: AbortSignal.timeout(1000),
      });
      p.socket.write(Buffer.concat([header, body]));
      await closed;
      assert.equal(calls, 0);
    } finally {
      await p.close();
    }
  });
}

for (const options of [
  { handler: null },
  { handler: async () => "", timeoutMs: 0 },
  { handler: async () => "", timeoutMs: NaN },
  { handler: async () => "", maxConcurrent: 17 },
]) {
  test("RPC rejects invalid trusted configuration before creating resources", () => {
    const dir = path.join("/tmp", `gondolin-rpc-test-${randomUUID()}`);
    assert.throws(
      () =>
        new RpcChannel(
          path.join(dir, "channel.sock"),
          options as RpcChannelOptions,
        ),
      /rpcChannel/,
    );
    assert.equal(fs.existsSync(dir), false);
  });
}
