import { constants } from "node:fs";
import { appendFile, mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { AskError } from "./errors.ts";
import { type Entry, extractTitle, formatEntry, formatHeader } from "./transcript.ts";

export interface DiscussionSummary {
  id: number;
  title: string;
}

const ACTIVE_FILE = ".active";
// Canonical ids only: "2.md" is discussion 2, while "002.md" or "0.md" are not discussions,
// so a listed id always maps back to the same file via discussionPath().
const DISCUSSION_FILE = /^([1-9]\d*)\.md$/;
const CANONICAL_ID = /^[1-9]\d*$/;
const MAX_CREATE_ATTEMPTS = 100;

/** Storage directory. ASK_HOME exists only so tests can use a temp dir. */
export function storageDir(): string {
  return process.env.ASK_HOME ?? join(homedir(), "dev", "tmp");
}

function discussionPath(id: number): string {
  return join(storageDir(), `${id}.md`);
}

async function ensureDir(): Promise<void> {
  await mkdir(storageDir(), { recursive: true });
}

export async function listIds(): Promise<number[]> {
  let dirents;
  try {
    dirents = await readdir(storageDir(), { withFileTypes: true });
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  // ~/dev/tmp is shared with other things: only regular files named like "N.md" count.
  return dirents
    .filter((d) => d.isFile())
    .map((d) => DISCUSSION_FILE.exec(d.name)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .filter(Number.isSafeInteger)
    .sort((a, b) => a - b);
}

export async function exists(id: number): Promise<boolean> {
  return (await listIds()).includes(id);
}

/** Creates the next N.md with the question as title and first user entry, and makes it active. */
export async function createDiscussion(question: string, at = new Date()): Promise<number> {
  if (question.trim() === "") throw new AskError("The question cannot be empty.");
  await ensureDir();

  const content = formatHeader(question) + formatEntry({ author: "user", at: at.toISOString(), body: question });
  let id = ((await listIds()).at(-1) ?? 0) + 1;
  // "wx" fails if the path already exists, so a concurrent `ask new` (or a non-discussion
  // entry such as a directory named "3.md") is never overwritten; take the next id instead.
  for (let attempt = 0; ; attempt++, id++) {
    try {
      await writeFile(discussionPath(id), content, { flag: "wx" });
      break;
    } catch (err) {
      if (!isAlreadyExists(err) || attempt + 1 >= MAX_CREATE_ATTEMPTS) throw err;
    }
  }
  await setActive(id);
  return id;
}

/**
 * Reads a discussion, applying the same rule as listIds(): only a regular file counts.
 * O_NOFOLLOW rejects symlinks and the type check runs on the opened handle, so there is
 * no gap between checking and reading.
 */
export async function read(id: number): Promise<string> {
  const missing = new AskError(`Discussion ${id} does not exist.`);
  let handle;
  try {
    handle = await open(discussionPath(id), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = errorCode(err);
    if (code === "ENOENT" || code === "ELOOP" || code === "EISDIR") throw missing;
    if (code === "EACCES" || code === "EPERM") throw new AskError(`Discussion ${id} cannot be read: permission denied.`);
    throw err;
  }
  try {
    if (!(await handle.stat()).isFile()) throw missing;
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export async function append(id: number, entry: Entry): Promise<void> {
  if (!(await exists(id))) throw new AskError(`Discussion ${id} does not exist.`);
  await appendFile(discussionPath(id), formatEntry(entry));
}

export async function list(): Promise<DiscussionSummary[]> {
  const ids = await listIds();
  return Promise.all(ids.map(async (id) => ({ id, title: extractTitle(await read(id)) })));
}

/** Active discussion id, or null if none is set or it no longer exists. */
export async function getActive(): Promise<number | null> {
  let raw: string;
  try {
    raw = await readFile(join(storageDir(), ACTIVE_FILE), "utf8");
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  const id = parseId(raw.trim());
  if (id === null || !(await exists(id))) return null;
  return id;
}

/** Parses a canonical discussion id ("2"); null for "02", "1garbage", "-1", "1.0", ... */
export function parseId(text: string): number | null {
  if (!CANONICAL_ID.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) ? id : null;
}

/** Like getActive, but throws a helpful error when there is no active discussion. */
export async function requireActive(): Promise<number> {
  const id = await getActive();
  if (id === null) throw new AskError('No active discussion. Start one with: ask new "<question>"');
  return id;
}

export async function setActive(id: number): Promise<void> {
  if (!(await exists(id))) throw new AskError(`Discussion ${id} does not exist.`);
  const target = join(storageDir(), ACTIVE_FILE);
  // Unique per call: concurrent updates (even within one process) never share a temp file.
  const tmp = `${target}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${id}\n`);
  await rename(tmp, target);
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function isNotFound(err: unknown): boolean {
  return errorCode(err) === "ENOENT";
}

function isAlreadyExists(err: unknown): boolean {
  return errorCode(err) === "EEXIST";
}
