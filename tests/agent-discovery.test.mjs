import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverAgents } from "../server/agent-discovery.mjs";
import { writeFixtureFile } from "./fixtures/smartorder.mjs";

const POSIX = process.platform !== "win32";
const skill = (name) => `---\nname: ${name}\ndescription: ${name}\n---\n# ${name}\n`;
const plist = (bundleId, version) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>\n`;

async function createDiscoveryHome(home) {
  // Known Agents: never candidates.
  await writeFixtureFile(home, ".claude/skills/a/SKILL.md", skill("a"));
  await writeFixtureFile(home, ".codex/skills/b/SKILL.md", skill("b"));
  // Unknown dot folders: direct skills/ and one level below (resources/skills).
  await writeFixtureFile(home, ".zcode/skills/z1/SKILL.md", skill("z1"));
  await writeFixtureFile(home, ".zcode/skills/z2/SKILL.md", skill("z2"));
  await writeFixtureFile(home, ".cola/resources/skills/c1/SKILL.md", skill("c1"));
  await writeFixtureFile(home, ".dismissed/skills/d1/SKILL.md", skill("d1"));
  await writeFixtureFile(home, ".cache/skills/x/SKILL.md", skill("x"));
  await writeFixtureFile(home, ".empty/skills/README.md", "no skills");
  // Application Support data folders.
  await writeFixtureFile(home, "Library/Application Support/CherryStudio/Data/skills/s1/SKILL.md", skill("s1"));
  // An app with a ~/.<name> skills folder; an app only reached by a ~/.local/bin link.
  const apps = path.join(home, "Applications");
  await writeFixtureFile(apps, "Qoder.app/Contents/Info.plist", plist("com.qoder.ide", "0.9.0"));
  await writeFixtureFile(home, ".qoder/skills/q1/SKILL.md", skill("q1"));
  await writeFixtureFile(apps, "Claude.app/Contents/Info.plist", plist("com.anthropic.claudefordesktop", "1.0.0"));
  const vclaw = path.join(apps, "pcsuite.app", "Contents", "Resources", "VClaw", "VClaw.app");
  await writeFixtureFile(vclaw, "Contents/Info.plist", plist("com.example.vclaw", "1.5.6"));
  const cli = await writeFixtureFile(vclaw, "Contents/Resources/cli/vclaw-cli", "#!/bin/sh\n");
  await chmod(cli, 0o755);
  const bin = path.join(home, ".local", "bin");
  await mkdir(bin, { recursive: true });
  await symlink(cli, path.join(bin, "vclaw-cli"));
  // A launcher with its own ~/.<name>/skills folder; backups are ignored.
  await writeFixtureFile(home, ".lumilab/skills/l1/SKILL.md", skill("l1"));
  await chmod(await writeFixtureFile(bin, "lumilab", "#!/bin/sh\nexec ~/.lumilab/bin/lumilab \"$@\"\n"), 0o755);
  await chmod(await writeFixtureFile(bin, "qoder.bak", "#!/bin/sh\n"), 0o755);
  // A link that leaves the home is not followed.
  const outside = await mkdtemp(path.join(tmpdir(), "discovery-outside-"));
  await writeFixtureFile(outside, "skills/o1/SKILL.md", skill("o1"));
  await symlink(outside, path.join(home, ".outside"));
  return { outside, apps };
}

test("discovery: unknown skill folders, apps and ~/.local/bin leads; known, ignored and outside ones are left out", { timeout: 30_000, skip: !POSIX }, async (context) => {
  const home = await mkdtemp(path.join(tmpdir(), "discovery-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const { outside, apps } = await createDiscoveryHome(home);
  context.after(() => rm(outside, { recursive: true, force: true }));
  const result = await discoverAgents({
    homeDirectory: home,
    homes: [home],
    known: {
      roots: [path.join(home, ".claude", "skills"), path.join(home, ".codex", "skills")],
      ids: new Set(["claude", "codex"]),
      apps: { names: new Set(["Claude.app"]), bundleIds: new Set(["com.anthropic.claudefordesktop"]) },
    },
    ignored: ["~/.dismissed/skills"],
    applicationDirectories: [apps],
  });
  const byId = Object.fromEntries(result.candidates.map((candidate) => [candidate.id, candidate]));
  assert.deepEqual(Object.keys(byId).sort(), ["cherrystudio", "cola", "lumilab", "qoder", "vclaw", "zcode"]);
  assert.deepEqual([byId.zcode.path, byId.zcode.skillCount], ["~/.zcode/skills", 2]);
  assert.equal(byId.cola.path, "~/.cola/resources/skills");
  assert.equal(byId.cherrystudio.path, "~/Library/Application Support/CherryStudio/Data/skills");
  assert.deepEqual([byId.qoder.appPath, byId.qoder.guessName], ["~/Applications/Qoder.app", "Qoder"]);
  assert.equal(byId.lumilab.launcher, "~/.local/bin/lumilab");
  assert.deepEqual([byId.vclaw.skillCount, byId.vclaw.appPath], [0, "~/Applications/pcsuite.app/Contents/Resources/VClaw/VClaw.app"]);
  assert.match(byId.vclaw.reason, /vclaw-cli/u);
  assert.equal(result.truncated, false);
  assert.equal(JSON.stringify(result).includes(home), false);
  assert.equal(JSON.stringify(result).includes(outside), false);
  // Results are sorted by skill count.
  assert.deepEqual(result.candidates.map((candidate) => candidate.skillCount), [...result.candidates.map((candidate) => candidate.skillCount)].sort((a, b) => b - a));
});

test("discovery respects its time budget", { skip: !POSIX }, async (context) => {
  const home = await mkdtemp(path.join(tmpdir(), "discovery-budget-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await writeFixtureFile(home, ".zcode/skills/z1/SKILL.md", skill("z1"));
  let clock = 0;
  const result = await discoverAgents({ homeDirectory: home, known: { roots: [], ids: new Set(), apps: { names: new Set(), bundleIds: new Set() } }, budgetMs: 10, now: () => (clock += 100) });
  assert.equal(result.truncated, true);
});
