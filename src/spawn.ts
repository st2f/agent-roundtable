import { spawn } from "node:child_process";

export interface RunOptions {
  command: string;
  args: string[];
  input: string; // written to stdin, then stdin is closed
  cwd: string;
  signal?: AbortSignal; // on abort, the child's process group receives SIGINT
  killGraceMs?: number; // after abort, SIGKILL the group if it's still running after this long
  closeGraceMs?: number; // after the child exits, wait at most this long for its pipes to close
}

export interface RunResult {
  code: number | null; // null when the child was killed by a signal
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const KILL_GRACE_MS = 3000;
const CLOSE_GRACE_MS = 1000;

/**
 * Runs a command to completion, feeding `input` on stdin and capturing stdout/stderr.
 * Rejects only if the process cannot be started (e.g. ENOENT); a non-zero exit resolves
 * normally so the caller decides what counts as failure.
 *
 * Always settles in bounded time after the child exits or the signal aborts:
 * - The child leads its own process group (detached), so cancellation reaches every
 *   descendant, not just the immediate child; survivors get SIGKILL after killGraceMs.
 * - A descendant holding inherited stdout/stderr open would delay "close" indefinitely, so
 *   after "exit" we wait at most closeGraceMs before resolving with the output so far.
 * - If this process exits first (e.g. a second Ctrl-C), the group is killed, not orphaned.
 */
export function runProcess(options: RunOptions): Promise<RunResult> {
  const { command, args, input, cwd, signal } = options;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  const closeGraceMs = options.closeGraceMs ?? CLOSE_GRACE_MS;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], detached: true });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));

    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let closeTimer: NodeJS.Timeout | undefined;

    const killGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        // Group already gone.
      }
    };
    const onAbort = () => {
      killGroup("SIGINT");
      killTimer = setTimeout(() => killGroup("SIGKILL"), killGraceMs);
    };
    const onParentExit = () => killGroup("SIGKILL");

    const cleanup = () => {
      clearTimeout(killTimer);
      clearTimeout(closeTimer);
      signal?.removeEventListener("abort", onAbort);
      process.off("exit", onParentExit);
      // On cancellation, nothing from the group may outlive the call.
      if (signal?.aborted) killGroup("SIGKILL");
    };
    const finish = (code: number | null, exitSignal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code, signal: exitSignal, stdout, stderr });
    };

    process.on("exit", onParentExit);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
    child.on("exit", (code, exitSignal) => {
      closeTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code, exitSignal);
      }, closeGraceMs);
    });
    child.on("close", (code, exitSignal) => finish(code, exitSignal));

    // The child may exit without reading all of stdin (EPIPE); its exit status reports that.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
