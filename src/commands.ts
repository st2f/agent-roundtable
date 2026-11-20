import { AskError } from "./errors.ts";
import * as store from "./store.ts";
import { extractTitle } from "./transcript.ts";

/** Output sink, injectable so tests can capture what a command prints. */
export interface IO {
  out(text: string): void;
  err(text: string): void;
}

export const processIO: IO = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

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
