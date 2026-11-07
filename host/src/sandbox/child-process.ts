import type { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import type { SandboxLogStream } from "./controller.ts";

/** VMM child processes that must be killed when the host process exits */
const activeChildren = new Set<ChildProcess>();
const failedSpawns = new WeakSet<ChildProcess>();
let exitHookRegistered = false;

/** SIGKILL all tracked child processes (best-effort) */
export function killActiveChildren() {
  for (const child of activeChildren) {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
}

/** Number of currently tracked child processes */
export function getActiveChildrenCount(): number {
  return activeChildren.size;
}

function registerExitHook() {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.once("exit", () => {
    killActiveChildren();
  });
}

/** Track a child so it is killed when the host process exits */
export function trackChild(child: ChildProcess) {
  registerExitHook();
  activeChildren.add(child);
  const cleanup = () => {
    activeChildren.delete(child);
    child.off("exit", cleanup);
    child.off("error", onError);
  };
  const onError = () => {
    // Errors from kill/send do not establish that a spawned process exited.
    if (child.pid !== undefined) return;
    failedSpawns.add(child);
    cleanup();
  };
  child.once("exit", cleanup);
  child.on("error", onError);
}

/** Re-emit child stdout/stderr chunks as `log` events on `emitter` */
export function forwardChildLogs(emitter: EventEmitter, child: ChildProcess) {
  child.stdout?.on("data", (chunk) => {
    emitter.emit("log", chunk.toString(), "stdout" satisfies SandboxLogStream);
  });
  child.stderr?.on("data", (chunk) => {
    emitter.emit("log", chunk.toString(), "stderr" satisfies SandboxLogStream);
  });
}

function bestEffort(fn: () => void) {
  try {
    fn();
  } catch {
    // ignore
  }
}

/**
 * Bounded shutdown of the owned VMM process: SIGTERM, then SIGKILL.
 * Only an observed exit or a failed spawn without a PID confirms termination.
 * At the deadline, detach this child's pipes so Node can exit, but reject:
 * detachment and successful signal delivery are not termination evidence.
 * This confirms the runner, not arbitrary descendants or delegated host work.
 */
export async function terminateChild(
  child: ChildProcess,
  options: {
    /** hard cap on waiting for exit in `ms` */
    closeTimeoutMs?: number;
    /** delay between SIGTERM and SIGKILL in `ms` */
    sigkillAfterMs?: number;
  } = {},
): Promise<void> {
  const closeTimeoutMs = options.closeTimeoutMs ?? 10_000;
  const sigkillAfterMs = options.sigkillAfterMs ?? 3000;
  for (const value of [closeTimeoutMs, sigkillAfterMs]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
      throw new Error("Invalid VMM termination limit");
    }
  }
  if (
    typeof child.exitCode === "number" ||
    typeof child.signalCode === "string" ||
    failedSpawns.has(child)
  ) {
    return;
  }

  let exited = false;
  let exitHandler: (() => void) | null = null;
  let errorHandler: ((err: Error) => void) | null = null;

  const waitForExit = new Promise<"exit">((resolve) => {
    exitHandler = () => {
      exited = true;
      resolve("exit");
    };
    errorHandler = () => {
      if (child.pid !== undefined) return;
      failedSpawns.add(child);
      exitHandler?.();
    };
    child.once("exit", exitHandler);
    child.on("error", errorHandler);
  });

  bestEffort(() => child.kill("SIGTERM"));

  const sigkillTimer = setTimeout(() => {
    if (!exited) bestEffort(() => child.kill("SIGKILL"));
  }, sigkillAfterMs);

  // Hard cap on waiting for the child to exit.
  let closeTimeoutTimer: NodeJS.Timeout | null = null;
  try {
    const outcome = await Promise.race([
      waitForExit,
      new Promise<"timeout">((resolve) => {
        closeTimeoutTimer = setTimeout(
          () => resolve("timeout"),
          closeTimeoutMs,
        );
      }),
    ]);
    if (outcome === "exit") return;
  } finally {
    if (closeTimeoutTimer) {
      clearTimeout(closeTimeoutTimer);
    }
    clearTimeout(sigkillTimer);
    if (exitHandler) child.off("exit", exitHandler);
    if (errorHandler) child.off("error", errorHandler);
  }

  // The child is still around: do not keep the event loop alive waiting for it.
  bestEffort(() => child.kill("SIGKILL"));

  // Last resort: detach the child so it cannot keep Node alive.
  bestEffort(() => (child.stdin as any)?.destroy?.());
  bestEffort(() => (child.stdout as any)?.destroy?.());
  bestEffort(() => (child.stderr as any)?.destroy?.());
  bestEffort(() => child.unref());

  // Keep exit-hook tracking until actual exit; never kill another VM here.
  throw new Error("VMM termination not confirmed before deadline");
}
