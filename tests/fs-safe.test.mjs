import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { findSkillDirectoryNames, readBoundedText, text } from "../server/fs-safe.mjs";
import { scanMcpInventory } from "../server/mcp-inventory.mjs";
import { writeFixtureFile } from "./fixtures/smartorder.mjs";

const POSIX = process.platform !== "win32";

async function tempDir(context) {
  const directory = await mkdtemp(path.join(tmpdir(), "fs-safe-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("strips format characters and caps outbound strings", () => {
  assert.equal(text("abc‮def​ghi", 160), "abcdefghi");
  assert.equal(text("a\u0000b", 160), "a b");
  assert.equal(text("x".repeat(500), 10), "x".repeat(10));
});

test("does not hang on a FIFO planted at a configuration path", { skip: !POSIX }, async (context) => {
  const home = await tempDir(context);
  await mkdir(path.join(home, ".cursor"), { recursive: true });
  execFileSync("mkfifo", [path.join(home, ".cursor", "mcp.json")]);
  assert.equal((await readBoundedText(path.join(home, ".cursor", "mcp.json"), 1_000)).status, "unreadable");
  const inventory = await scanMcpInventory(home);
  assert.deepEqual(inventory.servers, []);
  assert.equal(inventory.warnings.length, 1);
});

test("visits each real directory once when skill folders link back to themselves", { skip: !POSIX }, async (context) => {
  const root = await tempDir(context);
  const skills = path.join(root, "skills");
  await writeFixtureFile(skills, "nested/real-skill/SKILL.md", "---\nname: real-skill\n---\n");
  for (let index = 0; index < 12; index += 1) {
    await symlink(skills, path.join(skills, `self-${index}`));
    await symlink(skills, path.join(skills, "nested", `back-${index}`));
  }
  const started = performance.now();
  const names = await findSkillDirectoryNames(skills, root, { maxDepth: 6 });
  assert.deepEqual(names, ["real-skill"]);
  assert.ok(performance.now() - started < 500);
});
