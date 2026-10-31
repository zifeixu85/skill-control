import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { detectInstalledAgents, skillsDirectoryState } from "../server/agent-detection.mjs";
import { startTestServer } from "./fixtures/server.mjs";
import { writeFixtureFile } from "./fixtures/smartorder.mjs";

const POSIX = process.platform !== "win32";
const skill = (name) => `---\nname: ${name}\ndescription: ${name} fixture\n---\n# ${name}\n`;

async function tempHome(context, prefix = "detect-") {
  const home = await mkdtemp(path.join(tmpdir(), prefix));
  context.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

const detect = (home) =>
  detectInstalledAgents({ homeDirectory: home, env: {}, applicationDirectories: [path.join(home, "Applications")], commandDirectories: [{ directory: path.join(home, "bin"), nvm: false }] });

test("skill folders and the shared library are never install evidence", async (context) => {
  const home = await tempHome(context);
  await writeFixtureFile(home, ".agents/skills/shared/SKILL.md", skill("shared"));
  await writeFixtureFile(home, ".claude/skills/mine/SKILL.md", skill("mine"));
  await writeFixtureFile(home, ".codex/skills/mine/SKILL.md", skill("mine"));
  await writeFixtureFile(home, ".kiro/skills/mine/SKILL.md", skill("mine"));
  await writeFixtureFile(home, ".kiro/.DS_Store", "");
  const found = await detect(home);
  assert.deepEqual([...found].filter(([, value]) => value.installed).map(([id]) => id), []);
  assert.equal(await skillsDirectoryState(["~/.claude/skills"], home), "present");
});

test("product files, homes in use, commands, apps and extensions are", { skip: !POSIX }, async (context) => {
  const home = await tempHome(context);
  await writeFixtureFile(home, ".claude.json", "{}\n");
  await writeFixtureFile(home, ".codex/sessions/2026/11/01/rollout.jsonl", "");
  await writeFixtureFile(home, ".kiro/settings.json", "{}\n");
  await writeFixtureFile(home, ".vscode/extensions/saoudrizwan.claude-dev-3.1.0/package.json", "{}\n");
  const gemini = await writeFixtureFile(home, "bin/gemini", "#!/bin/sh\n");
  await chmod(gemini, 0o755);
  await writeFixtureFile(home, "Applications/Cursor.app/Contents/Info.plist", '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.todesktop.230313mzl4w4u92</string></dict></plist>\n');
  // Right name, wrong bundle id: not WorkBuddy.
  await writeFixtureFile(home, "Applications/WorkBuddy.app/Contents/Info.plist", '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>example.other</string></dict></plist>\n');
  const found = await detect(home);
  const installed = Object.fromEntries([...found].filter(([, value]) => value.installed).map(([id, value]) => [id, value.evidence]));
  assert.deepEqual(installed, {
    claude: ["~/.claude.json"],
    codex: ["~/.codex/sessions"],
    kiro: ["~/.kiro"],
    cline: ["extension:saoudrizwan.claude-dev"],
    gemini: ["command:gemini"],
    cursor: ["app:Cursor.app"],
  });
  assert.equal(await skillsDirectoryState(["~/.claude/skills"], home), "missing");
});

test("the service offers installed Agents only: no placeholders, primary Agents sanitized, 'no skills folder yet' exposed", { timeout: 60_000, skip: !POSIX }, async (context) => {
  // Nothing installed: no Agents at all (v0.2 put Codex, Claude Code and WorkBuddy here).
  const empty = await tempHome(context, "detect-empty-");
  await writeFixtureFile(empty, ".agents/skills/shared/SKILL.md", skill("shared"));
  const bare = await startTestServer(context, empty);
  const bareConfig = await bare.requestJson("/api/config");
  assert.deepEqual([bareConfig.agents, bareConfig.primaryAgentIds, bareConfig.visibleAgentIds], [[], null, []]);
  assert.deepEqual((await bare.requestJson("/api/scan")).agents, []);

  // A v0.2 config with three primary Agents, of which only Claude Code is installed (no skills folder yet).
  const home = await tempHome(context, "detect-config-");
  await writeFixtureFile(home, ".claude/settings.json", "{}\n");
  await writeFixtureFile(home, ".agents/skills/shared/SKILL.md", skill("shared"));
  await writeFixtureFile(home, ".agent-skill-manager/config.json", `${JSON.stringify({
    version: 3,
    agents: [
      { id: "codex", name: "Codex", paths: ["~/.codex/skills", "~/.agents/skills"] },
      { id: "claude", name: "Claude Code", paths: ["~/.claude/skills"] },
      { id: "workbuddy", name: "WorkBuddy", paths: ["~/.workbuddy/skills"] },
      { id: "mine", name: "My tool", paths: ["~/tools/skills"] },
    ],
    primaryAgentIds: ["codex", "claude", "workbuddy"],
    visibleAgentIds: ["codex", "claude", "workbuddy"],
    knownAgentIds: ["codex", "claude", "workbuddy", "mine"],
  })}\n`);
  const server = await startTestServer(context, home);
  const config = await server.requestJson("/api/config");
  assert.deepEqual([config.agents.map((agent) => agent.id), config.primaryAgentIds, config.newAgentIds], [["claude", "mine"], ["claude"], []]);
  const scan = await server.requestJson("/api/scan?force=1");
  const claude = scan.agents.find((agent) => agent.id === "claude");
  assert.deepEqual([claude.installed, claude.skillsDir, claude.detectedBy], [true, "missing", ["~/.claude/settings.json"]]);
  assert.deepEqual(scan.agents.find((agent) => agent.id === "mine").installed, true, "Agents added by hand count as installed");
  assert.equal(scan.agents.some((agent) => agent.id === "codex"), false, "~/.agents/skills does not make Codex installed");
});
