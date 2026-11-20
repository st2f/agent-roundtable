import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { AskError } from "../src/errors.ts";
import * as store from "../src/store.ts";
import { parse } from "../src/transcript.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ask-test-"));
  process.env.ASK_HOME = join(dir, "nested", "store"); // also checks the dir is created on demand
});

afterEach(async () => {
  delete process.env.ASK_HOME;
  await rm(dir, { recursive: true, force: true });
});

describe("store", () => {
  test("empty store has no discussions and no active one", async () => {
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.getActive(), null);
    await assert.rejects(store.requireActive(), AskError);
  });

  test("new discussions get sequential ids and become active", async () => {
    assert.equal(await store.createDiscussion("First?"), 1);
    assert.equal(await store.createDiscussion("Second?"), 2);
    assert.equal(await store.getActive(), 2);
    assert.deepEqual(await store.list(), [
      { id: 1, title: "First?" },
      { id: 2, title: "Second?" },
    ]);
  });

  test("next id follows the highest existing id, not the count", async () => {
    await store.createDiscussion("a");
    await writeFile(join(store.storageDir(), "7.md"), "# seven\n");
    assert.equal(await store.createDiscussion("b"), 8);
  });

  test("ignores unrelated files in the storage dir", async () => {
    await store.createDiscussion("a");
    await writeFile(join(store.storageDir(), "notes.md"), "# notes\n");
    await writeFile(join(store.storageDir(), "2.txt"), "x");
    assert.deepEqual(await store.listIds(), [1]);
  });

  test("non-canonical names and directories are not discussions", async () => {
    await store.createDiscussion("a");
    await writeFile(join(store.storageDir(), "002.md"), "# padded\n");
    await writeFile(join(store.storageDir(), "0.md"), "# zero\n");
    await mkdir(join(store.storageDir(), "3.md"));
    assert.deepEqual(await store.listIds(), [1]);
    assert.deepEqual(await store.list(), [{ id: 1, title: "a" }]);
  });

  test("read() agrees with listIds(): symlinks and directories are not discussions", async () => {
    await writeFile(join(dir, "elsewhere.md"), "# outside\n");
    await store.createDiscussion("a"); // creates the storage dir
    await symlink(join(dir, "elsewhere.md"), join(store.storageDir(), "2.md"));
    await mkdir(join(store.storageDir(), "3.md"));

    assert.deepEqual(await store.listIds(), [1]);
    for (const id of [2, 3]) {
      await assert.rejects(store.read(id), { name: "AskError", message: `Discussion ${id} does not exist.` });
    }
  });

  test("creation skips ids whose path is taken by something else", async () => {
    await store.createDiscussion("a");
    await mkdir(join(store.storageDir(), "2.md"));
    assert.equal(await store.createDiscussion("b"), 3);
  });

  test("concurrent creates all succeed with distinct ids", async () => {
    const ids = await Promise.all(["a", "b", "c", "d", "e"].map((q) => store.createDiscussion(q)));
    assert.deepEqual([...ids].sort((x, y) => x - y), [1, 2, 3, 4, 5]);
    assert.ok(ids.includes((await store.getActive()) ?? -1));
  });

  test("concurrent setActive calls all succeed and leave no temp files", async () => {
    await store.createDiscussion("a");
    await store.createDiscussion("b");
    await Promise.all([1, 2, 1, 2, 1].map((id) => store.setActive(id)));
    assert.ok([1, 2].includes((await store.getActive()) ?? -1));
    const leftovers = (await readdir(store.storageDir())).filter((n) => n.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  });

  test("first entry is the question, attributed to the user", async () => {
    const id = await store.createDiscussion("Should we introduce Qdrant?");
    const { title, entries } = parse(await store.read(id));
    assert.equal(title, "Should we introduce Qdrant?");
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.author, "user");
    assert.equal(entries[0]?.body, "Should we introduce Qdrant?");
  });

  test("append adds entries in order", async () => {
    const id = await store.createDiscussion("q");
    await store.append(id, { author: "codex", at: "t1", cwd: "/x", body: "reply" });
    await store.append(id, { author: "user", to: "claude", at: "t2", body: "follow-up" });

    const authors = parse(await store.read(id)).entries.map((e) => e.author);
    assert.deepEqual(authors, ["user", "codex", "user"]);
  });

  test("use switches the active discussion; unknown ids are rejected", async () => {
    await store.createDiscussion("a");
    await store.createDiscussion("b");
    await store.setActive(1);
    assert.equal(await store.getActive(), 1);
    assert.equal((await readFile(join(store.storageDir(), ".active"), "utf8")).trim(), "1");

    await assert.rejects(store.setActive(99), AskError);
    await assert.rejects(store.read(99), AskError);
    await assert.rejects(store.append(99, { author: "user", at: "t", body: "x" }), AskError);
  });

  test("an .active pointing to a missing or garbage id counts as no active discussion", async () => {
    await store.createDiscussion("a");
    await writeFile(join(store.storageDir(), ".active"), "42\n");
    assert.equal(await store.getActive(), null);
    for (const garbage of ["nope\n", "1garbage\n", "01\n", "-1\n", "1.0\n", "1 2\n"]) {
      await writeFile(join(store.storageDir(), ".active"), garbage);
      assert.equal(await store.getActive(), null, JSON.stringify(garbage));
    }
  });

  test("empty question is rejected", async () => {
    await assert.rejects(store.createDiscussion("   "), AskError);
  });
});
