# Guest-to-host RPC

The optional `virtio-rpc` port carries bounded application messages from a guest
process to a trusted, per-VM host callback. It is independent of networking,
exec control, VFS, SSH and ingress. No listener is exposed through guest TCP/IP.

```ts
import { VM } from "@earendil-works/gondolin";

const vm = await VM.create({
  sandbox: {
    vmm: "qemu",
    netEnabled: false,
    rpcChannel: {
      timeoutMs: 30000,
      maxConcurrent: 4,
      handler: async ({ channel, payload, signal }) => {
        if (channel !== "echo" || signal.aborted) {
          throw new Error("Request refused");
        }
        return payload;
      },
    },
  },
});

try {
  // Discover virtio-rpc through sysfs, then open its /dev/vport* device.
} finally {
  await vm.close();
}
```

## Availability and lifecycle

QEMU only. Requesting RPC on krun or with `sandbox.autoRestart` enabled throws;
it is never silently disabled. No device or RPC listener is created unless
`sandbox.rpcChannel` is supplied. Linux exposes the named virtio port through
sysfs; no new guest daemon or image rebuild is needed.

The host listener uses a unique private directory with mode `0700`, removed
at shutdown. The channel aborts pending handlers on peer disconnection, VM stop
or close. A channel that has closed cannot reconnect: start a new VM. Manual
restart and changed boot configurations that would restart the VM are rejected
before mutating the active boot configuration. Automatic QEMU idle pausing is
disabled for VMs with RPC so a waiting guest can receive
its response.

## Guest device discovery

Do not assume `/dev/virtio-ports/virtio-rpc` exists. That convenient symlink
requires udev/mdev setup and is not guaranteed by the image's init script.
Enumerate `/sys/class/virtio-ports/vport*/name`, read each name, and select the
entry whose trimmed contents equal `virtio-rpc`. Open the corresponding
`/dev/vport*` character device with read/write access. Validate the device name
before forming its path; do not select the first port or a control/VFS port.

Wait only for a bounded period while the port and device node appear. The
Node client in `host/test/virtio-rpc-vm.test.ts` retries missing entries every
25 milliseconds for at most 5 seconds, using a monotonic clock. Unexpected
filesystem errors fail immediately. It uses only Node built-ins.

## Wire protocol

One guest client owns the port for the VM lifetime. Frames use the existing
Gondolin encoding: a four-byte unsigned big-endian CBOR byte length, followed
by the CBOR map. Each request has exactly these fields:

```json
{
  "v": 1,
  "t": "rpc_request",
  "id": 1,
  "p": { "channel": "echo", "payload": "hello" }
}
```

- `id`: integer from 1 through 4294967295, strictly increasing across the whole
  VM lifetime, including requests refused as busy. Duplicates/replays close the
  channel; do not reset the counter between guest processes.
- `channel`: 1–64 lowercase ASCII letters, digits, dots, underscores or hyphens;
  the first character must be a letter.
- `payload`: opaque string, at most 65536 UTF-8 bytes. Applications may put JSON
  inside this string, but must parse and validate it themselves.

Successful responses have the same `id` and channel:

```json
{
  "v": 1,
  "t": "rpc_response",
  "id": 1,
  "p": { "channel": "echo", "ok": true, "payload": "hello" }
}
```

Application failures return `ok: false` with `error` set to `busy`, `timeout`,
`handler_failed` or `invalid_response`. Exception details are never forwarded.
Malformed frames, invalid fields, excess payload bytes or duplicate CBOR keys
close the channel without invoking the callback. Framing is bounded by the
existing 4 MiB reader; RPC rejects frames above 66560 bytes before decoding.
The response string has the same 65536-byte limit as the request.

## Limits and application security

`timeoutMs` defaults to 30000, with an integer range of 1–300000. The concurrency
limit defaults to 4, with an integer range of 1–16. A timeout aborts the signal
and returns one failure, but retains the handler's slot until it settles. A
callback that ignores cancellation cannot create unbounded replacement work.
Output backpressure is bounded; overflow permanently closes the channel.

The callback is a host execution boundary, not a safe tool dispatcher. The
application must enforce its own channel/tool allowlist, per-run authorization,
argument validation, workspace boundaries, response redaction and auditing.
Never turn guest text into shell commands, arbitrary executable arguments,
filesystem access or host environment variables. Real host credentials remain
host-side. An RPC authorization token, if used by the application, is not a
research-provider or Git credential.

## Tests

From `host/`, using Node's built-in TypeScript support:

```bash
node --test test/virtio-rpc.test.ts test/virtio-rpc-wiring.test.ts
node --test test/virtio-rpc-vm.test.ts
```

The VM test requires hardware virtualization and the normal Alpine guest
assets with Node. It removes any named RPC symlink in its disposable guest,
then exercises the actual `/dev/vport*` device through sysfs discovery with
networking disabled, without any guest dependency installation. A second VM
case verifies the discovery deadline when RPC is not configured. These tests
skip when hardware acceleration is unavailable; skipped tests are not live evidence. Tool delegation and the
real Mulch/Seeds round trips belong to the calling application, not this generic
transport test.
