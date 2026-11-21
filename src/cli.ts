#!/usr/bin/env node
import { type Agent, defaultAgents } from "./agents/index.ts";
import { type IO, add, askAgent, list, newDiscussion, processIO, show, use } from "./commands.ts";
import { AskError } from "./errors.ts";
import { storageDir } from "./store.ts";

type Command = (args: string[], io: IO) => Promise<void>;

const COMMANDS: Record<string, Command> = { new: newDiscussion, add, list, show, use };
const HELP_FLAGS = ["help", "-h", "--help"];

function usage(): string {
  return `Usage: ask <command> [args]

Discussions:
  ask new "<question>"     Start a discussion and make it active
  ask add "<text>"         Add your message to the active discussion
  ask list                 List discussions (* = active)
  ask show [N]             Print the active discussion, or discussion N
  ask use N                Switch the active discussion

Agents:
  ask codex ["<prompt>"]   Ask Codex to contribute (optional follow-up prompt)
  ask claude ["<prompt>"]  Ask Claude to contribute (optional follow-up prompt)

Discussions are stored in ${storageDir()}
`;
}

/** Runs one ask invocation and returns the exit code. */
export async function main(
  argv: string[],
  io: IO = processIO,
  agents: Record<string, Agent> = defaultAgents(),
): Promise<number> {
  const [command, ...args] = argv;
  if (command === undefined) {
    io.err(usage());
    return 1;
  }
  if (HELP_FLAGS.includes(command)) {
    io.out(usage());
    return 0;
  }

  try {
    const agent = Object.hasOwn(agents, command) ? agents[command] : undefined;
    if (agent) {
      await withInterrupt((signal) => askAgent(agent, args, io, { cwd: process.cwd(), signal }));
      return 0;
    }
    const run = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
    if (!run) throw new AskError(`Unknown command: ${command}. Run "ask help" for usage.`);
    await run(args, io);
    return 0;
  } catch (err) {
    if (err instanceof AskError) {
      io.err(`ask: ${err.message}\n`);
      return err.exitCode;
    }
    io.err(`ask: unexpected error\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    return 1;
  }
}

/**
 * Ctrl-C while an agent runs: abort (the agent's process group gets SIGINT) and let the
 * command fail cleanly without writing a partial entry. A second Ctrl-C exits right away
 * via process.exit, whose "exit" hook in runProcess kills the agent's process group (Node's
 * default SIGINT death would skip that hook and orphan it).
 */
async function withInterrupt<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const onSigint = () => {
    if (controller.signal.aborted) process.exit(130);
    controller.abort();
  };
  process.on("SIGINT", onSigint);
  try {
    return await fn(controller.signal);
  } finally {
    process.off("SIGINT", onSigint);
  }
}

if (import.meta.main) {
  // exitCode instead of process.exit() so pending stdout writes are flushed.
  process.exitCode = await main(process.argv.slice(2));
}
