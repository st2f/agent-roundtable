import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { promisify } from "node:util";
import {
  CODEX_ALLOWED_FEATURES,
  codexArgs,
  createCodexAgent,
  featuresToDisable,
  parseFeatures,
} from "../src/agents/codex.ts";
import { AskError } from "../src/errors.ts";

const FEATURES = `apps                                     stable             true
shell_tool                               stable             true
view_image                               stable             true
shiny_new_thing                          under development  true
worktrees                                removed            true
goals                                    stable             false
`;

// A stand-in `codex` binary.
// - `features list`: records CODEX_HOME (and its contents), prints FAKE_FEATURES.
// - `exec`: records argv/stdin/cwd, prints progress noise, writes the reply to the -o file.
// Behavior per FAKE_MODE.
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
const mode = process.env.FAKE_MODE || "ok";
if (argv[0] === "features") {
  const home = process.env.CODEX_HOME;
  fs.writeFileSync(process.env.FAKE_LOG + ".features", JSON.stringify({ argv, home, homeEntries: fs.readdirSync(home) }));
  if (mode === "features-fail") { process.stderr.write("features broke\\n"); process.exit(2); }
  process.stdout.write(mode === "features-garbage" ? "something unexpected\\n" : process.env.FAKE_FEATURES);
  process.exit(0);
}
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  const out = argv[argv.indexOf("-o") + 1];
  fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ argv, input, cwd: process.cwd(), out }));
  process.stdout.write("progress noise that must not become the reply\\n");
  if (mode === "fail") { process.stderr.write("ERROR: model_not_found\\n"); process.exit(1); }
  if (mode === "no-output") return;
  if (mode === "empty") { fs.writeFileSync(out, "\\n"); return; }
  fs.writeFileSync(out, "  indented first line\\nsecond line\\n");
});
`;

let dir: string;
let fake: string;
let log: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ask-codex-test-"));
  fake = join(dir, "codex");
  log = join(dir, "log.json");
  await writeFile(fake, FAKE_CODEX);
  await chmod(fake, 0o755);
  process.env.FAKE_LOG = log;
  process.env.FAKE_FEATURES = FEATURES;
});

afterEach(async () => {
  for (const key of ["FAKE_LOG", "FAKE_MODE", "FAKE_FEATURES"]) delete process.env[key];
  await rm(dir, { recursive: true, force: true });
});

const prompt = { rules: 'RULES with "quotes"\nand a second line', input: "<discussion>…</discussion>" };

describe("codex feature allowlist", () => {
  test("parses names, multi-word stages and states", () => {
    assert.deepEqual(parseFeatures(FEATURES).slice(3, 5), [
      { name: "shiny_new_thing", stage: "under development", enabled: true },
      { name: "worktrees", stage: "removed", enabled: true },
    ]);
  });

  test("unparsable or empty output is an error, not an empty disable list", () => {
    assert.throws(() => parseFeatures("apps stable true\nsurprise\n"), AskError);
    assert.throws(() => parseFeatures("\n"), AskError);
  });

  test("disables every known feature that isn't allowlisted, whatever its probed state", () => {
    // goals is probed off but disabled anyway (workspace defaults can turn it on at run time);
    // worktrees is removed and skipped; allowlisted features stay on.
    assert.deepEqual(featuresToDisable(parseFeatures(FEATURES)), ["apps", "shiny_new_thing", "goals"]);
  });

  test("risky features are not allowlisted", () => {
    for (const f of ["apps", "plugins", "hooks", "computer_use", "browser_use", "daemon_auto_start", "multi_agent"]) {
      assert.ok(!CODEX_ALLOWED_FEATURES.has(f), f);
    }
  });
});

describe("codex adapter", () => {
  test("read-only flags are always present", () => {
    const args = codexArgs({ rules: prompt.rules, disable: ["apps", "hooks"], outputFile: "/tmp/out.md" });
    const flag = (name: string) => args[args.indexOf(name) + 1];
    assert.equal(args[0], "exec");
    assert.equal(flag("--sandbox"), "read-only");
    for (const f of ["--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules"]) {
      assert.ok(args.includes(f), f);
    }
    assert.ok(args.includes('approval_policy="never"'));
    assert.ok(args.includes('web_search="disabled"'));
    const disabled = args.flatMap((a, i) => (args[i - 1] === "--disable" ? [a] : []));
    assert.deepEqual(disabled, ["apps", "hooks"]);
    assert.ok(!args.some((a) => a.includes("dangerously")));
    assert.equal(flag("-o"), "/tmp/out.md");
    assert.equal(args.at(-1), "-");
  });

  test("passes the model with --model only when one is given", async () => {
    const base = { rules: prompt.rules, disable: [], outputFile: "/tmp/out.md" };
    assert.ok(!codexArgs(base).includes("--model"));
    await createCodexAgent(fake).run(prompt, { cwd: dir, model: "gpt-5.6-sol" });
    const seen = JSON.parse(await readFile(log, "utf8"));
    assert.equal(seen.argv[seen.argv.indexOf("--model") + 1], "gpt-5.6-sol");
  });

  test("rules go in developer_instructions as a TOML string; stdin carries only the discussion", async () => {
    await createCodexAgent(fake).run(prompt, { cwd: dir });
    const seen = JSON.parse(await readFile(log, "utf8"));
    assert.equal(seen.input, prompt.input);

    const override = seen.argv.find((a: string) => a.startsWith("developer_instructions="));
    const value = override.slice("developer_instructions=".length);
    assert.match(value, /^"[^\n]*"$/, "single-line quoted string");
    assert.equal(JSON.parse(value), prompt.rules);
  });

  test("feature list comes from an empty, temporary CODEX_HOME; its result drives --disable", async () => {
    await createCodexAgent(fake).run(prompt, { cwd: dir });
    const features = JSON.parse(await readFile(`${log}.features`, "utf8"));
    assert.deepEqual(features.argv, ["features", "list"]);
    assert.notEqual(features.home, process.env.CODEX_HOME);
    assert.deepEqual(features.homeEntries, []);
    await assert.rejects(stat(features.home), { code: "ENOENT" }); // removed afterwards

    const seen = JSON.parse(await readFile(log, "utf8"));
    const disabled = seen.argv.flatMap((a: string, i: number) => (seen.argv[i - 1] === "--disable" ? [a] : []));
    assert.deepEqual(disabled, ["apps", "shiny_new_thing", "goals"]);
  });

  test("reply comes from the -o file, not stdout; runs in cwd; temp dir is removed", async () => {
    const reply = await createCodexAgent(fake).run(prompt, { cwd: dir });
    assert.equal(reply, "  indented first line\nsecond line");

    const seen = JSON.parse(await readFile(log, "utf8"));
    assert.equal(await realpath(seen.cwd), await realpath(dir));
    await assert.rejects(stat(dirname(seen.out)), { code: "ENOENT" });
  });

  test("if the feature list can't be read, codex exec never runs", async () => {
    for (const mode of ["features-fail", "features-garbage"]) {
      process.env.FAKE_MODE = mode;
      await assert.rejects(createCodexAgent(fake).run(prompt, { cwd: dir }), AskError, mode);
      await assert.rejects(stat(log), { code: "ENOENT" }, mode);
    }
  });

  test("non-zero exit becomes an AskError with the stderr tail", async () => {
    process.env.FAKE_MODE = "fail";
    await assert.rejects(createCodexAgent(fake).run(prompt, { cwd: dir }), (err: unknown) => {
      assert.ok(err instanceof AskError);
      assert.equal(err.message, "codex failed (exit code 1).\n  ERROR: model_not_found");
      return true;
    });
  });

  test("success without an output file is a failure", async () => {
    process.env.FAKE_MODE = "no-output";
    await assert.rejects(createCodexAgent(fake).run(prompt, { cwd: dir }), {
      name: "AskError",
      message: "codex finished without writing a reply.",
    });
  });

  test("empty reply is a failure", async () => {
    process.env.FAKE_MODE = "empty";
    await assert.rejects(createCodexAgent(fake).run(prompt, { cwd: dir }), {
      name: "AskError",
      message: "codex returned an empty reply.",
    });
  });

  test("missing binary gives a clear message", async () => {
    await assert.rejects(createCodexAgent(join(dir, "nope")).run(prompt, { cwd: dir }), {
      name: "AskError",
      message: /^codex CLI not found in PATH/,
    });
  });
});

describe("withTempDir", () => {
  test("removes the dir even when the process exits mid-run (second Ctrl-C)", async () => {
    const common = join(import.meta.dirname, "..", "src", "agents", "common.ts");
    const script = `
      const { withTempDir } = await import(${JSON.stringify(common)});
      await withTempDir("ask-exit-test-", async (d) => {
        console.log(d);
        process.exit(130); // skips the finally block, like the second Ctrl-C handler
      });
    `;
    const run = promisify(execFile);
    const err = await run(process.execPath, ["--input-type=module", "-e", script]).catch((e) => e);
    assert.equal(err.code, 130);
    const tempDir = String(err.stdout).trim();
    assert.ok(tempDir.includes("ask-exit-test-"), tempDir);
    await assert.rejects(stat(tempDir), { code: "ENOENT" });
  });
});
