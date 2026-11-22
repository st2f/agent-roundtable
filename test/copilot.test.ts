import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  COPILOT_TOOLS,
  checkCopilotModel,
  copilotArgs,
  copilotInput,
  createCopilotAgent,
} from "../src/agents/copilot.ts";
import { AskError } from "../src/errors.ts";

// A stand-in `copilot` binary: records argv, stdin and cwd, then behaves per FAKE_MODE.
const FAKE_COPILOT = `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), input, cwd: process.cwd() }));
  const mode = process.env.FAKE_MODE || "ok";
  if (mode === "fail") { process.stderr.write("Error: Model \\"nope\\" is not available.\\n"); process.exit(1); }
  if (mode === "empty") { process.stdout.write("\\n"); return; }
  process.stdout.write("    indented code\\nsecond line\\n\\n");
});
`;

let dir: string;
let fake: string;
let log: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ask-copilot-test-"));
  fake = join(dir, "copilot");
  log = join(dir, "log.json");
  await writeFile(fake, FAKE_COPILOT);
  await chmod(fake, 0o755);
  process.env.FAKE_LOG = log;
});

afterEach(async () => {
  delete process.env.FAKE_LOG;
  delete process.env.FAKE_MODE;
  await rm(dir, { recursive: true, force: true });
});

const prompt = { rules: "RULES", input: "<discussion>…</discussion>" };

describe("copilot adapter", () => {
  test("read-only flags are always present, whatever the model", () => {
    const args = copilotArgs("gpt-6.2-sol");
    assert.deepEqual(COPILOT_TOOLS, ["view", "grep", "glob"]);
    assert.ok(args.includes("--available-tools=view,grep,glob"));
    assert.ok(args.includes("--allow-tool=read"));
    assert.ok(args.includes("--allow-all-paths"));
    assert.ok(args.includes("--deny-tool=shell,write,memory,url"));
    for (const flag of [
      "--disable-builtin-mcps",
      "--no-custom-instructions",
      "--no-ask-user",
      "--no-auto-update",
      "-s",
    ]) {
      assert.ok(args.includes(flag), flag);
    }
    // Nothing that widens permissions, trusts the repo, or takes the prompt from argv.
    for (const flag of [
      "--allow-all",
      "--yolo",
      "--allow-all-tools",
      "--allow-all-urls",
      "--trust-folder",
      "--autopilot",
      "-p",
      "--prompt",
    ]) {
      assert.ok(!args.includes(flag), flag);
    }
    // Every flag is one self-contained argument (except --stream off), so none can swallow another.
    assert.equal(args.filter((a) => !a.startsWith("-")).join(" "), "off");
  });

  test("the model is a single --model= argument, so it can never be read as a flag", () => {
    const args = copilotArgs("--yolo");
    assert.equal(args[0], "--model=--yolo");
    assert.ok(!args.includes("--yolo"));
  });

  test("sends rules then discussion on stdin, runs in cwd; keeps reply indentation", async () => {
    const reply = await createCopilotAgent(fake).run(prompt, {
      cwd: dir,
      model: "gpt-6.2-sol",
    });
    assert.equal(reply, "    indented code\nsecond line");

    const seen = JSON.parse(await readFile(log, "utf8"));
    assert.deepEqual(seen.argv, copilotArgs("gpt-6.2-sol"));
    assert.equal(seen.input, copilotInput("RULES", prompt.input));
    assert.equal(seen.input, "RULES\n\n<discussion>…</discussion>");
    assert.equal(await realpath(seen.cwd), await realpath(dir));
  });

  test("without a model it fails before running the CLI", async () => {
    await assert.rejects(createCopilotAgent(fake).run(prompt, { cwd: dir }), {
      name: "AskError",
      message: 'copilot needs a model. Usage: ask copilot -m <model> ["<prompt>"]',
    });
    await assert.rejects(readFile(log), { code: "ENOENT" });
  });

  test("automatic model selection is rejected: one voice must be one model", async () => {
    for (const model of ["auto", "Auto", "fusion"]) {
      await assert.rejects(createCopilotAgent(fake).run(prompt, { cwd: dir, model }), {
        name: "AskError",
        message: new RegExp(`^copilot needs a specific model, not "${model}"`),
      });
    }
    await assert.rejects(readFile(log), { code: "ENOENT" });
    assert.doesNotThrow(() => checkCopilotModel("gpt-6.2-sol"));
    assert.doesNotThrow(() => checkCopilotModel("claude-opus-5-5-auto-tuned")); // only exact names
  });

  test("non-zero exit (e.g. unknown model) becomes an AskError with the stderr tail", async () => {
    process.env.FAKE_MODE = "fail";
    await assert.rejects(
      createCopilotAgent(fake).run(prompt, { cwd: dir, model: "nope" }),
      (err: unknown) => {
        assert.ok(err instanceof AskError);
        assert.equal(
          err.message,
          'copilot failed (exit code 1).\n  Error: Model "nope" is not available.',
        );
        return true;
      },
    );
  });

  test("empty output is a failure", async () => {
    process.env.FAKE_MODE = "empty";
    await assert.rejects(
      createCopilotAgent(fake).run(prompt, { cwd: dir, model: "m" }),
      {
        name: "AskError",
        message: "copilot returned an empty reply.",
      },
    );
  });

  test("missing binary gives a clear message", async () => {
    await assert.rejects(
      createCopilotAgent(join(dir, "nope")).run(prompt, {
        cwd: dir,
        model: "m",
      }),
      {
        name: "AskError",
        message: /^copilot CLI not found in PATH/,
      },
    );
  });
});
