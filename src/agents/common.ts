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

function tail(output: string): string {
  const lines = output.trimEnd().split("\n").slice(-STDERR_TAIL_LINES);
  if (lines.join("").trim() === "") return "";
  return `\n${lines.map((l) => `  ${l}`).join("\n")}`;
}
