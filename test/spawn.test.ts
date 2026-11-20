import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { describe, test } from "node:test";
import { runProcess } from "../src/spawn.ts";

const node = (script: string, input = "", signal?: AbortSignal) =>
  runProcess({ command: process.execPath, args: ["-e", script], input, cwd: tmpdir(), signal });

/**
 * A child that spawns a grandchild sharing its stdout/stderr; the grandchild ignores SIGINT.
 * The child prints the grandchild's pid, then exits on SIGINT (or right away with "exit-now").
 */
function grandchildScript(mode = "wait") {
  const grandchild = `process.on("SIGINT",()=>{});setInterval(()=>{},1000)`;
  const script = `
    const { spawn } = require("node:child_process");
    const g = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: ["ignore", "inherit", "inherit"] });
    process.stdout.write("grandchild=" + g.pid + "\\n");
    process.on("SIGINT", () => process.exit(130));
    if (${JSON.stringify(mode)} === "exit-now") process.exit(0);
    setInterval(() => {}, 1000);
  `;
  return { command: process.execPath, args: ["-e", script], input: "", cwd: tmpdir() };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("runProcess", () => {
  test("feeds stdin and captures stdout/stderr", async () => {
    const r = await node(
      `let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(s.toUpperCase());process.stderr.write("log")})`,
      "hello",
    );
    assert.deepEqual(r, { code: 0, signal: null, stdout: "HELLO", stderr: "log" });
  });

  test("runs in the given cwd", async () => {
    const r = await runProcess({ command: process.execPath, args: ["-p", "process.cwd()"], input: "", cwd: "/" });
    assert.equal(r.stdout.trim(), "/");
  });

  test("a non-zero exit resolves with the code", async () => {
    const r = await node(`process.stderr.write("boom");process.exit(3)`);
    assert.equal(r.code, 3);
    assert.equal(r.stderr, "boom");
  });

  test("a child that ignores stdin does not crash the parent", async () => {
    const r = await node("process.exit(0)", "x".repeat(1_000_000));
    assert.equal(r.code, 0);
  });

  test("a missing command rejects with ENOENT", async () => {
    await assert.rejects(
      runProcess({ command: "definitely-not-a-real-command-xyz", args: [], input: "", cwd: tmpdir() }),
      { code: "ENOENT" },
    );
  });

  test("abort escalates to SIGKILL when the child ignores SIGINT", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const running = runProcess({
      command: process.execPath,
      args: ["-e", `process.on("SIGINT",()=>{});process.stdout.write("ready");setInterval(()=>{},1000)`],
      input: "",
      cwd: tmpdir(),
      signal: controller.signal,
      killGraceMs: 300,
    });
    setTimeout(() => controller.abort(), 200);
    const r = await running;
    assert.equal(r.signal, "SIGKILL");
    assert.ok(Date.now() - started < 3000, "settles in bounded time");
  });

  test("abort settles and kills descendants that hold the pipes open", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const running = runProcess({ ...grandchildScript(), signal: controller.signal, killGraceMs: 300, closeGraceMs: 300 });
    setTimeout(() => controller.abort(), 300);
    const r = await running;
    assert.ok(Date.now() - started < 3000, "settles in bounded time");
    assert.equal(r.code, 130);

    const grandchild = Number(/grandchild=(\d+)/.exec(r.stdout)?.[1]);
    assert.ok(grandchild > 0, r.stdout);
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(isAlive(grandchild), false, "grandchild was killed with the group");
  });

  test("normal exit settles even if a descendant keeps the pipes open", async () => {
    const started = Date.now();
    const r = await runProcess({ ...grandchildScript("exit-now"), closeGraceMs: 300 });
    assert.equal(r.code, 0);
    assert.ok(Date.now() - started < 3000, "settles in bounded time");
    const grandchild = Number(/grandchild=(\d+)/.exec(r.stdout)?.[1]);
    if (grandchild > 0 && isAlive(grandchild)) process.kill(grandchild, "SIGKILL");
  });

  test("abort sends SIGINT to the child", async () => {
    const controller = new AbortController();
    const running = node(`process.stdout.write("ready");setInterval(()=>{},1000)`, "", controller.signal);
    setTimeout(() => controller.abort(), 200);
    const r = await running;
    assert.equal(r.signal, "SIGINT");
    assert.equal(r.code, null);
  });
});
