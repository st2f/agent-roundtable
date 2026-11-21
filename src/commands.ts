import type { Agent } from "./agents/types.ts";
import { AskError } from "./errors.ts";
import { buildPrompt } from "./prompt.ts";
import * as store from "./store.ts";
import { extractTitle, parse } from "./transcript.ts";

/** Output sink, injectable so tests can capture what a command prints. */
export interface IO {
  out(text: string): void;
  err(text: string): void;
  /** Transient progress line (null clears it). Optional: tests and pipes don't need it. */
  status?(text: string | null): void;
}

export const processIO: IO = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  status: (text) => {
    if (!process.stderr.isTTY) return;
    process.stderr.write(text === null ? "\r\x1b[K" : `\r\x1b[K${text}`);
  },
};

export interface AgentContext {
  cwd: string; // where the agent runs; independent of discussion storage
  signal?: AbortSignal;
}

/**
 * `ask <agent> ["<prompt>"]`: the follow-up (if any) is saved before the agent runs, and
 * the reply is saved only if the agent succeeds, so a failure never loses or corrupts history.
 */
export async function askAgent(agent: Agent, args: string[], io: IO, ctx: AgentContext): Promise<void> {
  const id = await store.requireActive();
  const followUp = args.join(" ");
  const hasFollowUp = followUp.trim() !== "";
  if (hasFollowUp) {
    await store.append(id, { author: "user", to: agent.name, at: new Date().toISOString(), body: followUp });
  }

  const prompt = buildPrompt(agent.name, parse(await store.read(id)), hasFollowUp ? followUp : undefined);
  let reply: string;
  io.status?.(`${agent.name} is thinking…`);
  try {
    reply = await agent.run(prompt, ctx);
  } catch (err) {
    if (err instanceof AskError && hasFollowUp) {
      // Name the discussion explicitly: the active one may have changed while the agent ran.
      const hint = `Your message was saved to discussion ${id}; to retry, run: ask use ${id} && ask ${agent.name}`;
      throw new AskError(`${err.message}\n${hint}`, { exitCode: err.exitCode, cause: err });
    }
    throw err;
  } finally {
    io.status?.(null);
  }

  await store.append(id, { author: agent.name, at: new Date().toISOString(), cwd: ctx.cwd, body: reply });
  io.out(`${reply}\n`);
}

/** `ask new "<question>"`: creates a discussion and makes it active. */
export async function newDiscussion(args: string[], io: IO): Promise<void> {
  const question = joinText(args, 'ask new "<question>"');
  const id = await store.createDiscussion(question);
  const title = await titleOf(id);
  io.out(`Started discussion ${id}: ${title}\n`);
}

/** `ask add "<text>"`: appends a user entry to the active discussion, no model call. */
export async function add(args: string[], io: IO): Promise<void> {
  const text = joinText(args, 'ask add "<text>"');
  const id = await store.requireActive();
  await store.append(id, { author: "user", at: new Date().toISOString(), body: text });
  io.out(`Added to discussion ${id}.\n`);
}

/** `ask list`: all discussions, active one marked with `*`. */
export async function list(args: string[], io: IO): Promise<void> {
  expectArgs(args, 0, 0, "ask list");
  const [discussions, active] = await Promise.all([store.list(), store.getActive()]);
  if (discussions.length === 0) {
    io.out('No discussions yet. Start one with: ask new "<question>"\n');
    return;
  }
  const width = String(discussions.at(-1)?.id ?? 0).length;
  for (const { id, title } of discussions) {
    const marker = id === active ? "*" : " ";
    io.out(`${marker} ${String(id).padStart(width)}  ${title}\n`);
  }
}

/** `ask show [N]`: prints the active (or given) discussion as stored. */
export async function show(args: string[], io: IO): Promise<void> {
  expectArgs(args, 0, 1, "ask show [N]");
  const id = args[0] === undefined ? await store.requireActive() : requireId(args[0]);
  io.out(await store.read(id));
}

/** `ask use N`: switches the active discussion. */
export async function use(args: string[], io: IO): Promise<void> {
  expectArgs(args, 1, 1, "ask use N");
  const id = requireId(args[0] ?? "");
  // Read first: if the discussion can't be read, fail without switching.
  const title = await titleOf(id);
  await store.setActive(id);
  io.out(`Switched to discussion ${id}: ${title}\n`);
}

async function titleOf(id: number): Promise<string> {
  return extractTitle(await store.read(id));
}

function requireId(text: string): number {
  const id = store.parseId(text);
  if (id === null) throw new AskError(`Invalid discussion id: ${JSON.stringify(text)}. Expected a number like 2.`);
  return id;
}

/** Joins arguments so unquoted text (`ask add hello world`) works too; rejects empty text. */
function joinText(args: string[], usage: string): string {
  const text = args.join(" ");
  if (text.trim() === "") throw new AskError(`Missing text. Usage: ${usage}`);
  return text;
}

function expectArgs(args: string[], min: number, max: number, usage: string): void {
  if (args.length < min || args.length > max) throw new AskError(`Usage: ${usage}`);
}
