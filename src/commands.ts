import type { Agent } from "./agents/types.ts";
import { AskError } from "./errors.ts";
import { MODEL_NAME, buildPrompt } from "./prompt.ts";
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

const isModelFlag = (arg = "") =>
  arg === "-m" || arg === "--model" || arg.startsWith("--model=");

/** Leading `-m <model>` / `--model <model>` / `--model=<model>`, then the follow-up words. */
export function parseAgentArgs(
  agent: string,
  args: string[],
): { model?: string; words: string[] } {
  const usage = `Usage: ask ${agent} [-m <model>] ["<prompt>"]`;
  const [first, ...rest] = args;
  let model: string | undefined;
  let words = args;
  if (first === "-m" || first === "--model") {
    model = rest[0];
    words = rest.slice(1);
    if (model === undefined) throw new AskError(`Missing model. ${usage}`);
  } else if (first?.startsWith("--model=")) {
    model = first.slice("--model=".length);
    words = rest;
  }
  if (model !== undefined && !MODEL_NAME.test(model)) {
    throw new AskError(
      `Invalid model name: ${JSON.stringify(model)}. ${usage}`,
    );
  }
  // A second model flag would otherwise be saved as the follow-up while the first model runs.
  if (model !== undefined && isModelFlag(words[0])) {
    throw new AskError(
      `Only one model per call. To start a prompt with "${words[0]}", put -- before it. ${usage}`,
    );
  }
  if (words[0] === "--") words = words.slice(1); // `ask claude -- "-m in my prompt"`
  return model === undefined ? { words } : { model, words };
}

/**
 * `ask <agent> [-m <model>] ["<prompt>"]`: the follow-up (if any) is saved before the agent
 * runs, and the reply is saved only if the agent succeeds, so a failure never loses or
 * corrupts history.
 *
 * With a model, the speaker is `<agent>/<model>` (e.g. `copilot/gpt-6.2-sol`): follow-ups,
 * replies and the agent's identity in the prompt all use that name, so each model is a
 * separate participant. Without one it is just `<agent>`.
 */
export async function askAgent(
  agent: Agent,
  args: string[],
  io: IO,
  ctx: AgentContext,
): Promise<void> {
  const { model, words } = parseAgentArgs(agent.name, args);
  agent.checkModel?.(model);
  const speaker = model === undefined ? agent.name : `${agent.name}/${model}`;
  const id = await store.requireActive();
  const followUp = words.join(" ");
  const hasFollowUp = followUp.trim() !== "";
  if (hasFollowUp) {
    await store.append(id, {
      author: "user",
      to: speaker,
      at: new Date().toISOString(),
      body: followUp,
    });
  }

  const prompt = buildPrompt(
    speaker,
    parse(await store.read(id)),
    hasFollowUp ? followUp : undefined,
  );
  let reply: string;
  io.status?.(`${speaker} is thinking…`);
  try {
    reply = await agent.run(
      prompt,
      model === undefined ? ctx : { ...ctx, model },
    );
  } catch (err) {
    if (err instanceof AskError && hasFollowUp) {
      // Name the discussion explicitly: the active one may have changed while the agent ran.
      const retry =
        model === undefined
          ? `ask ${agent.name}`
          : `ask ${agent.name} -m ${model}`;
      const hint = `Your message was saved to discussion ${id}; to retry, run: ask use ${id} && ${retry}`;
      throw new AskError(`${err.message}\n${hint}`, {
        exitCode: err.exitCode,
        cause: err,
      });
    }
    throw err;
  } finally {
    io.status?.(null);
  }

  await store.append(id, {
    author: speaker,
    at: new Date().toISOString(),
    cwd: ctx.cwd,
    body: reply,
  });
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
  await store.append(id, {
    author: "user",
    at: new Date().toISOString(),
    body: text,
  });
  io.out(`Added to discussion ${id}.\n`);
}

/** `ask list`: all discussions, active one marked with `*`. */
export async function list(args: string[], io: IO): Promise<void> {
  expectArgs(args, 0, 0, "ask list");
  const [discussions, active] = await Promise.all([
    store.list(),
    store.getActive(),
  ]);
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
  const id =
    args[0] === undefined ? await store.requireActive() : requireId(args[0]);
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
  if (id === null)
    throw new AskError(
      `Invalid discussion id: ${JSON.stringify(text)}. Expected a number like 2.`,
    );
  return id;
}

/** Joins arguments so unquoted text (`ask add hello world`) works too; rejects empty text. */
function joinText(args: string[], usage: string): string {
  const text = args.join(" ");
  if (text.trim() === "") throw new AskError(`Missing text. Usage: ${usage}`);
  return text;
}

function expectArgs(
  args: string[],
  min: number,
  max: number,
  usage: string,
): void {
  if (args.length < min || args.length > max)
    throw new AskError(`Usage: ${usage}`);
}
