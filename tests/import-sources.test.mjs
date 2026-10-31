import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { zipSync } from "fflate";
import { markInstalled } from "./fixtures/agents.mjs";
import { startTestServer } from "./fixtures/server.mjs";
import { writeFixtureFile } from "./fixtures/smartorder.mjs";

const POSIX = process.platform !== "win32";
const skill = (name) => `---\nname: ${name}\ndescription: ${name} fixture\n---\n# ${name}\n`;
const zip = (files) => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, Buffer.from(text)]))));

test("import: .zip from GitHub (one skill or a choice of several) and a folder the user picked", { timeout: 60_000, skip: !POSIX }, async (context) => {
  const home = await mkdtemp(path.join(tmpdir(), "import-sources-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await markInstalled(home, "claude");
  await mkdir(path.join(home, ".claude", "skills"), { recursive: true });
  const { request } = await startTestServer(context, home);
  const upload = (name, body, headers = {}) => request("/api/import-skill", { method: "POST", body, headers: { "x-skill-filename": encodeURIComponent(name), ...headers } });

  // A repository zip with one skill at its root: README and other files outside the skill are left out.
  const single = await upload("tool-main.zip", zip({ "tool-main/SKILL.md": skill("tool"), "tool-main/refs/a.md": "a", "tool-main/.github/workflows/ci.yml": "x" }));
  const one = await single.json();
  assert.equal(single.status, 200, JSON.stringify(one));
  assert.deepEqual([one.directoryName, one.fileCount, one.source, one.root], ["tool", 3, "zip", "tool-main"]);

  // Several skills: the list to choose from, then the chosen one.
  const repo = zip({ "repo-main/README.md": "readme", "repo-main/skills/alpha/SKILL.md": skill("alpha"), "repo-main/skills/beta/SKILL.md": skill("beta"), "repo-main/skills/beta/examples/x/SKILL.md": skill("x") });
  const many = await upload("repo-main.zip", repo);
  const choice = await many.json();
  assert.deepEqual([many.status, choice.code, choice.skills], [409, "multiple-skills", [{ root: "repo-main/skills/alpha", name: "alpha" }, { root: "repo-main/skills/beta", name: "beta" }]]);
  const picked = await (await upload("repo-main.zip", repo, { "x-skill-root": encodeURIComponent("repo-main/skills/beta") })).json();
  assert.deepEqual([picked.directoryName, picked.fileCount, picked.ignoredCount], ["beta", 2, 2]);
  assert.equal((await upload("repo-main.zip", repo, { "x-skill-root": "elsewhere" })).status, 400);
  assert.equal((await (await upload("notes.zip", zip({ "notes/readme.md": "x" }))).json()).code, "no-skill");

  // A folder: links are not followed, .git is skipped; then the usual install flow.
  const folder = path.join(home, "Downloads", "my-skill");
  await writeFixtureFile(folder, "SKILL.md", skill("my-skill"));
  await writeFixtureFile(folder, "references/guide.md", "guide");
  await writeFixtureFile(folder, ".git/HEAD", "ref: refs/heads/main\n");
  const outside = await mkdtemp(path.join(tmpdir(), "import-outside-"));
  context.after(() => rm(outside, { recursive: true, force: true }));
  await writeFixtureFile(outside, "secret.txt", "ZZ9importoutside01");
  await symlink(path.join(outside, "secret.txt"), path.join(folder, "linked.txt"));
  const post = (pathname, payload, headers = {}) => request(pathname, { method: "POST", body: JSON.stringify(payload), headers });
  const staged = await post("/api/import-folder", { path: folder });
  const imported = await staged.json();
  assert.equal(staged.status, 200, JSON.stringify(imported));
  assert.deepEqual([imported.source, imported.directoryName, imported.fileCount, imported.skippedLinks], ["folder", "my-skill", 2, 1]);
  assert.equal(JSON.stringify(imported).includes(home), false);
  const plan = await (await post("/api/install/plan", { source: { importId: imported.importId }, scope: "primary" })).json();
  assert.deepEqual([plan.mode, plan.items.map((item) => item.kind)], ["library", ["add", "link"]]);

  // A folder holding one skill folder works too (like a repository checkout).
  assert.equal((await (await post("/api/import-folder", { path: path.join(home, "Downloads") })).json()).root, "my-skill");
  for (const [payload, status] of [[{ path: home }, 400], [{ path: "Downloads/my-skill" }, 400], [{ path: path.join(home, "nope") }, 404]]) {
    assert.equal((await post("/api/import-folder", payload)).status, status, JSON.stringify(payload));
  }
  assert.equal((await post("/api/import-folder", { path: folder }, { "Sec-Fetch-Site": "cross-site" })).status, 403);
});
