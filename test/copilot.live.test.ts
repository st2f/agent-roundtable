// Live check against the real Copilot CLI, through `ask` itself, for one model per run.
// Makes a paid request, so it only runs when a model is named:
//
//   ASK_LIVE_COPILOT=gpt-6.2-sol node --test test/copilot.live.test.ts
//
// Needs `copilot` installed and signed in. One premium request. Run again for another model.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";
import { COPILOT_REVIEWED_VERSION } from "../src/agents/copilot.ts";
import { main } from "../src/cli.ts";
import * as store from "../src/store.ts";
import { parse } from "../src/transcript.ts";

const model = process.env.ASK_LIVE_COPILOT?.trim() ?? "";
const skip = model === "" ? "makes a paid request: set ASK_LIVE_COPILOT=<model> to run" : false;
const TIMEOUT = 5 * 60_000;

/** Runs `ask ...args` in-process with the real agents, capturing output. */
async function ask(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await main(args, { out: (t) => (out += t), err: (t) => (err += t) });
  return { code, out, err };
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe("copilot live", { skip }, () => {
  const originalCwd = process.cwd();
  let home: string | undefined; // discussion storage (ASK_HOME)
  let work: string | undefined; // the agent's cwd
  // Outside the cwd and outside the system temp dir, which Copilot may always read: inside
  // this repo, so reading it proves --allow-all-paths works. Gitignored, removed after.
  let outside: string | undefined;

  // Any failure here fails the suite before a single paid request is made.
  before(async () => {
    const { stdout } = await promisify(execFile)("copilot", ["version"]);
    const version = /^GitHub Copilot CLI (\S+)$/m.exec(stdout)?.[1];
    assert.equal(
      version,
      COPILOT_REVIEWED_VERSION,
      `Re-review copilotArgs() for this version. copilot version said:\n${stdout}`,
    );

    home = await mkdtemp(join(tmpdir(), "ask-live-home-"));
    work = await mkdtemp(join(tmpdir(), "ask-live-work-"));
    outside = await mkdtemp(join(import.meta.dirname, "..", ".live-test-"));
    process.env.ASK_HOME = home;
    process.chdir(work); // ask runs the agent in its own cwd
    assert.equal((await ask("new", "Copilot live check")).code, 0);
  });

  after(async () => {
    process.chdir(originalCwd);
    delete process.env.ASK_HOME;
    for (const dir of [home, work, outside]) {
      if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    }
  });

  test(`${model}: reads anywhere, cannot write, saved under its own voice`, { timeout: TIMEOUT }, async (t) => {
    assert.ok(work !== undefined && outside !== undefined);
    const token = `token-${randomBytes(6).toString("hex")}`;
    const secret = join(outside, "secret.txt");
    const edited = join(work, "edited.txt");
    const touched = join(work, "touched.txt");
    await writeFile(secret, `${token}\n`);

    const request = [
      "This is an automated permission check. Try every step, then reply.",
      `1. Create a file at ${edited} containing the word x.`,
      `2. Run the shell command: touch ${touched}`,
      `3. Read this file: ${secret}`,
      "Reply with the exact content of that file on the first line, then one line each on whether steps 1 and 2 worked, then the exact names of every tool you can call (including MCP tools), one per line.",
    ].join("\n");

    // The request itself must succeed: a run that fails before any tool call proves nothing.
    const r = await ask("copilot", "-m", model, request);
    assert.equal(r.code, 0, r.err);
    t.diagnostic(`reply from copilot/${model} (tools should be view, grep, glob):\n${r.out}`);

    assert.ok(r.out.includes(token), "reply lacks the file's token: stdin prompt, view tool or --allow-all-paths not working");
    assert.equal(await exists(edited), false, "an edit tool wrote a file");
    assert.equal(await exists(touched), false, "a shell command ran");
    assert.ok(!/github/i.test(r.out), "GitHub tools are available");

    const speaker = `copilot/${model}`;
    const entries = parse(await store.read(1)).entries;
    assert.deepEqual(
      entries.map((e) => [e.author, e.to, e.body]),
      [
        ["user", undefined, "Copilot live check"],
        ["user", speaker, request],
        [speaker, undefined, r.out.replace(/\n$/, "")],
      ],
    );
  });
});
