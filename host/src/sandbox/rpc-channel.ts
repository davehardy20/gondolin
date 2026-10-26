import fs from "node:fs";
import path from "node:path";
import { decode } from "cbor2";
import { VirtioBridge } from "./server-transport.ts";
import type { RpcRequest } from "./virtio-protocol.ts";

export const MAX_RPC_PAYLOAD_BYTES = 64 * 1024;
const MAX_RPC_FRAME_BYTES = MAX_RPC_PAYLOAD_BYTES + 1024;

/** Opaque UTF-8 messages on the dedicated guest-to-host virtio-rpc port */
export type RpcChannelOptions = {
  /** Trusted per-VM handler, responsible for application authorization */
  handler: (request: {
    /** Application channel identifier */
    channel: string;
    /** Opaque UTF-8 application message, at most `65536 bytes` */
    payload: string;
    /** Aborted on timeout, disconnection, or VM shutdown */
    signal: AbortSignal;
  }) => Promise<string>;
  /** Per-request deadline in `ms`, default `30000`, maximum `300000` */
  timeoutMs?: number;
  /** In-flight handlers including timed-out handlers, default `4`, maximum `16` */
  maxConcurrent?: number;
};

export function validateRpcChannelOptions(options: RpcChannelOptions): void {
  if (!options || typeof options.handler !== "function") {
    throw new Error("rpcChannel.handler must be a function");
  }
  for (const [value, max, name] of [
    [options.timeoutMs, 300_000, "timeoutMs"],
    [options.maxConcurrent, 16, "maxConcurrent"],
  ] as const) {
    if (
      value !== undefined &&
      (!Number.isInteger(value) || value < 1 || value > max)
    ) {
      throw new Error(`Invalid rpcChannel.${name}`);
    }
  }
}

function decodeRequest(frame: Buffer): RpcRequest {
  if (frame.length > MAX_RPC_FRAME_BYTES)
    throw new Error("RPC frame too large");
  const value: unknown = decode(frame, {
    preferMap: true,
    createObject(entries) {
      const result = new Map<string, unknown>();
      for (const [key, value] of entries) {
        if (typeof key !== "string" || result.has(key)) {
          throw new Error("invalid RPC map key");
        }
        result.set(key, value);
      }
      return result;
    },
    rejectDuplicateKeys: true,
    ignoreGlobalTags: true,
    maxDepth: 4,
  });
  if (
    !(value instanceof Map) ||
    value.size !== 4 ||
    value.get("v") !== 1 ||
    value.get("t") !== "rpc_request"
  ) {
    throw new Error("Invalid RPC frame");
  }
  const id: unknown = value.get("id");
  const p: unknown = value.get("p");
  if (
    typeof id !== "number" ||
    !Number.isInteger(id) ||
    id < 1 ||
    id > 0xffffffff ||
    !(p instanceof Map) ||
    p.size !== 2
  ) {
    throw new Error("Invalid RPC request");
  }
  const channel: unknown = p.get("channel");
  const payload: unknown = p.get("payload");
  if (
    typeof channel !== "string" ||
    !/^[a-z][a-z0-9._-]{0,63}$/.test(channel) ||
    typeof payload !== "string" ||
    Buffer.byteLength(payload) > MAX_RPC_PAYLOAD_BYTES
  ) {
    throw new Error("Invalid RPC payload");
  }
  return { v: 1, t: "rpc_request", id, p: { channel, payload } };
}

/** Internal transport; no application tool dispatch or host credentials */
export class RpcChannel {
  readonly socketPath: string;
  private readonly bridge: VirtioBridge;
  private readonly pending = new Map<
    number,
    { controller: AbortController; timer: NodeJS.Timeout }
  >();
  private readonly options: Required<RpcChannelOptions>;
  private lastId = 0;
  private closed = false;
  private ownsDirectory = false;
  private closing: Promise<void> | undefined;

  constructor(socketPath: string, options: RpcChannelOptions) {
    validateRpcChannelOptions(options);
    this.socketPath = socketPath;
    this.options = {
      handler: options.handler,
      timeoutMs: options.timeoutMs ?? 30_000,
      maxConcurrent: options.maxConcurrent ?? 4,
    };
    this.bridge = new VirtioBridge(
      socketPath,
      MAX_RPC_FRAME_BYTES * 4,
      decodeRequest,
    );
    this.bridge.onMessage = (message) => {
      if (message.t === "rpc_request") this.receive(message);
    };
    this.bridge.onError = () => {
      void this.close();
    };
    this.bridge.onDisconnect = () => {
      void this.close();
    };
  }

  get isClosed(): boolean {
    return this.closed;
  }

  connect(): void {
    if (this.closed || this.ownsDirectory) return;
    // Never adopt an existing directory or delete caller-owned contents.
    fs.mkdirSync(path.dirname(this.socketPath), { mode: 0o700 });
    this.ownsDirectory = true;
    this.bridge.connect();
  }

  close(): Promise<void> {
    this.closed = true;
    for (const { controller, timer } of this.pending.values()) {
      clearTimeout(timer);
      controller.abort();
    }
    this.pending.clear();
    this.closing ??= this.disconnect();
    return this.closing;
  }

  private async disconnect(): Promise<void> {
    await this.bridge.disconnect();
    if (this.ownsDirectory) {
      fs.rmSync(this.socketPath, { force: true });
      fs.rmdirSync(path.dirname(this.socketPath));
      this.ownsDirectory = false;
    }
  }

  private reply(
    id: number,
    channel: string,
    payload?: string,
    error?: string,
  ): void {
    if (this.closed) return;
    if (
      !this.bridge.send({
        v: 1,
        t: "rpc_response",
        id,
        p: error
          ? { channel, ok: false, error }
          : { channel, ok: true, payload },
      })
    ) {
      void this.close();
    }
  }

  private receive(request: RpcRequest): void {
    if (this.closed) return;
    const {
      id,
      p: { channel, payload },
    } = request;
    // Strict monotonic IDs bound replay state for the entire VM lifetime.
    if (id <= this.lastId) {
      void this.close();
      return;
    }
    this.lastId = id;
    if (this.pending.size >= this.options.maxConcurrent) {
      this.reply(id, channel, undefined, "busy");
      return;
    }
    const controller = new AbortController();
    let replied = false;
    const timer = setTimeout(() => {
      replied = true;
      controller.abort();
      this.reply(id, channel, undefined, "timeout");
      // Keep the slot occupied until the handler settles, even if it ignores abort.
    }, this.options.timeoutMs);
    this.pending.set(id, { controller, timer });
    void Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) return undefined;
        return this.options.handler({
          channel,
          payload,
          signal: controller.signal,
        });
      })
      .then(
        (result) => {
          if (replied || this.closed) return;
          if (
            typeof result !== "string" ||
            Buffer.byteLength(result) > MAX_RPC_PAYLOAD_BYTES
          ) {
            this.reply(id, channel, undefined, "invalid_response");
          } else {
            this.reply(id, channel, result);
          }
        },
        () => {
          if (!replied) this.reply(id, channel, undefined, "handler_failed");
        },
      )
      .finally(() => {
        clearTimeout(timer);
        this.pending.delete(id);
      });
  }
}
