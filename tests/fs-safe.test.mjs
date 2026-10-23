import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compactHomeInText,
  findSkillDirectoryNames,
  readBoundedText,
  text,
} from "../server/fs-safe.mjs";
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
  assert.ok(performance.now() - started < 3000);
});

test("compacts Windows and POSIX home paths in serialized text", () => {
  const windowsHome = "C:\\Users\\bob";
  const serialized = JSON.stringify({
    command: "C:\\Users\\bob\\bin\\srv.exe",
    args: ["C:/Users/bob/.cfg/x.json", "c:\\users\\BOB\\data", "C:\\Users\\bobby\\other"],
  });
  const compacted = compactHomeInText(serialized, [windowsHome]);
  assert.doesNotMatch(compacted, /Users\\\\bob\\\\|Users\/bob\//iu);
  assert.match(compacted, /~\\\\bin\\\\srv\.exe/u);
  assert.match(compacted, /~\/\.cfg\/x\.json/u);
  assert.match(compacted, /bobby/u);
  assert.equal(compactHomeInText("C:\\Users\\bob and C:/Users/bob", [windowsHome]), "~ and ~");
  assert.equal(
    compactHomeInText("file:///Users/alice/x /Users/alicexyz/y", ["/Users/alice"]),
    "file://~/x /Users/alicexyz/y",
  );
  // Markdown and Chinese punctuation end a home path too.
  assert.equal(compactHomeInText("在 `/Users/alice` 下，/Users/alice。<!-- /Users/alice -->", ["/Users/alice"]), "在 `~` 下，~。<!-- ~ -->");
});
