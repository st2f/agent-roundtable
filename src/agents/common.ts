import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AskError } from "../errors.ts";
import { type RunOptions, type RunResult, runProcess } from "../spawn.ts";

const STDERR_TAIL_LINES = 20;

/** Runs an agent CLI and maps every failure mode to a user-facing AskError. */
export async function runAgentProcess(name: string, options: RunOptions): Promise<RunResult> {
  let result: RunResult;
  try {
    result = await runProcess(options);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AskError(`${name} CLI not found in PATH (looked for "${options.command}").`, { cause: err });
    }
    throw err;
  }

  if (options.signal?.aborted) throw new AskError(`${name} was interrupted.`, { exitCode: 130 });
  if (result.code !== 0) {
    const how = result.code === null ? `killed by ${result.signal}` : `exit code ${result.code}`;
    throw new AskError(`${name} failed (${how}).${tail(result.stderr || result.stdout)}`);
  }
  return result;
}

/** Drops trailing whitespace (CLIs end output with a newline); rejects empty replies. */
export function cleanReply(name: string, text: string): string {
  const reply = text.replace(/\s+$/, "");
  if (reply.trim() === "") throw new AskError(`${name} returned an empty reply.`);
  return reply;
}

/**
 * Runs fn with a fresh private temp dir and always removes it: normally via finally, and
 * also if the process exits mid-run (a second Ctrl-C calls process.exit, which skips
 * pending finally blocks but still runs synchronous "exit" listeners).
 */
export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const removeOnExit = () => rmSync(dir, { recursive: true, force: true });
  process.on("exit", removeOnExit);
  try {
    return await fn(dir);
  } finally {
    process.off("exit", removeOnExit);
    await rm(dir, { recursive: true, force: true });
  }
}

function tail(output: string): string {
  const lines = output.trimEnd().split("\n").slice(-STDERR_TAIL_LINES);
  if (lines.join("").trim() === "") return "";
  return `\n${lines.map((l) => `  ${l}`).join("\n")}`;
}
