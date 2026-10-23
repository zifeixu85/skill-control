import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { listAgentFiles, readAgentFile } from "../server/agent-files.mjs";
import { hasAgentIcon } from "../server/agent-icons.mjs";
import { agentSettingsDetail } from "../server/agent-settings.mjs";
import { readAgentSwitches, tierOf } from "../server/library-agents.mjs";
import { disableOps } from "../server/library-switches.mjs";
import { scanAll } from "../server/local-server.mjs";
import { resolveRaccoonInstall, scanRaccoonExperts } from "../server/office-raccoon.mjs";
import { loadUsageIndex, runUsageIndex } from "../server/usage-index.mjs";
import { usageForAgent, usageSummary } from "../server/usage-query.mjs";
import { createRaccoonHome } from "./fixtures/office-raccoon.mjs";

const POSIX = process.platform !== "win32";
const LIMIT = { timeout: 30_000, skip: !POSIX };

async function setup(context) {
  const home = await mkdtemp(path.join(tmpdir(), "raccoon-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await createRaccoonHome(home);
  return home;
}

test("detects 办公小浣熊 and scans its skills the way the app loads them", LIMIT, async (context) => {
  const home = await setup(context);
  const install = await resolveRaccoonInstall(home);
  assert.deepEqual([install.available, install.version, install.workspaceDir], [true, "1.0.17", path.join(home, ".box-agent")]);
  const config = {
    agents: [{ id: "office-raccoon", name: "办公小浣熊", shortName: "浣", color: "#f2b56b", paths: [path.join(home, ".box-agent", "skills")] }],
    visibleAgentIds: ["office-raccoon"],
    primaryAgentIds: ["office-raccoon"],
  };
  const scan = await scanAll(config, { homeDirectory: home });
  const agent = scan.agents.find((item) => item.id === "office-raccoon");
  assert.deepEqual([agent.available, agent.productVersion, agent.copyOnly], [true, "1.0.17", true]);
  assert.match(agent.installRoot, /\.box-agent\/skills$/u);
  const instances = scan.skills.flatMap((skill) => skill.instances.filter((instance) => instance.agentId === "office-raccoon"));
  const byName = Object.fromEntries(instances.map((instance) => [instance.name, instance]));
  assert.deepEqual(Object.keys(byName).sort(), ["docx", "linked-skill", "opc-alpha", "opc-beta"], "plain .md files and .backups are not skills");
  assert.equal(byName["opc-alpha"].inactive, undefined);
  assert.equal(byName["opc-beta"].disabled, true, "skill-settings.json disabledSkillNames");
  assert.equal(byName["linked-skill"].hiddenByProduct, "symlink-not-followed", "the app skips symlinked folders");
  assert.deepEqual([byName.docx.readOnly, byName.docx.sourceLabel], [true, "内置"]);

  assert.equal(tierOf("office-raccoon"), "none");
  assert.deepEqual([...(await readAgentSwitches("office-raccoon", home)).disabled], ["opc-beta"]);
  const item = await disableOps({ agentId: "office-raccoon", name: "办公小浣熊", ownDirs: [] }, "opc-alpha", { homeDirectory: home, backupDirectory: path.join(home, "backups"), group: "g1" });
  assert.equal(item.ops[0].path, path.join(home, ".box-agent", "config", "skill-settings.json"));
  assert.deepEqual(JSON.parse(item.ops[0].content).disabledSkillNames, ["opc-alpha", "opc-beta"]);
  assert.equal(await disableOps({ agentId: "office-raccoon", name: "办公小浣熊", ownDirs: [] }, "opc-beta", { homeDirectory: home, backupDirectory: home, group: "g" }), null, "already off");
  assert.equal(await hasAgentIcon("office-raccoon", { homeDirectory: home, applicationDirectories: [path.join(home, "Applications")], platform: "darwin" }), true);
});

test("experts and teams with their skill dependencies; backups ignored; prompts scrubbed", LIMIT, async (context) => {
  const home = await setup(context);
  const product = await scanRaccoonExperts(home);
  assert.deepEqual([product.available, product.itemCount, product.memberCount, product.backupCount], [true, 2, 2, 1]);
  const expert = product.items.find((item) => item.kind === "expert");
  assert.deepEqual(expert.skillDependencies, { required: ["opc-alpha", "opc-missing"], default: [], optional: ["docx"], missing: ["opc-missing"] });
  assert.equal(expert.displayName, "市场分析师");
  // Sort fields: the profile's own times (null when the profile has none).
  assert.deepEqual([expert.createdAt, expert.updatedAt], [null, "2026-09-05T00:00:00.000Z"]);
  const team = product.items.find((item) => item.kind === "expert-team");
  assert.deepEqual(team.members.map((member) => [member.displayName, member.skills]), [["负责人", ["opc-alpha"]], ["研究员", ["opc-beta"]]]);
  const profile = expert.virtualFiles.get("profile.md");
  assert.match(profile, /# 市场分析师/u);
  assert.doesNotMatch(`${profile}${JSON.stringify(expert.defaultPrompt)}`, /ZZ9/u);
});

test("settings rows show safe facts only", LIMIT, async (context) => {
  const home = await setup(context);
  const detail = await agentSettingsDetail("office-raccoon", home, [home]);
  const rows = Object.fromEntries(detail.rows.map((row) => [row.label, row.value]));
  assert.equal(rows["API 密钥"], "已配置（不显示）");
  assert.equal(rows["接口地址"], "llm.raccoon-fixture.cn");
  assert.equal(rows["模型"], "raccoon-pro");
  assert.equal(rows["MCP 服务"], "playwright、search");
  assert.equal(rows["停用的技能"], "opc-beta");
  assert.equal(rows["工作目录"], "~/.box-agent");
  assert.doesNotMatch(JSON.stringify(detail), /ZZ9/u);
  assert.equal(JSON.stringify(detail).includes(home), false);
});

test("agent files: the memory folder and the app's memory entries, redacted", LIMIT, async (context) => {
  const home = await setup(context);
  const listing = await listAgentFiles("office-raccoon", { homeDirectory: home, homes: [home] });
  const groups = Object.fromEntries(listing.groups.map((group) => [group.id, group.files.map((file) => file.name)]));
  assert.deepEqual(groups, {
    memory: ["MEMORY.md", "memory_summary.md"],
    "memory-context": ["project.md"],
    "memory-v2": ["feedback.md"],
    "settings-memory": ["记忆条目 1.md", "记忆条目 2.md"],
  });
  const entries = listing.groups.find((group) => group.id === "settings-memory").files;
  const newest = await readAgentFile(entries[0].id, { homeDirectory: home, homes: [home] });
  const older = await readAgentFile(entries[1].id, { homeDirectory: home, homes: [home] });
  assert.equal(newest.language, "md");
  assert.match(newest.text, /^# 记忆条目 1\n[\s\S]*~\/work\/raccoon-project/u, "newest first, home compacted");
  assert.match(older.text, /api_key=••••••/u);
  assert.doesNotMatch(older.text, /ZZ9/u);
  const memory = await readAgentFile(listing.groups[0].files[0].id, { homeDirectory: home, homes: [home] });
  assert.doesNotMatch(memory.text, /ZZ9/u);
});

test("usage from local-chat.sqlite3: tokens and skill calls, never message text", LIMIT, async (context) => {
  const home = await setup(context);
  const indexPath = path.join(home, "index.json");
  await runUsageIndex({ homeDirectory: home, indexPath, budgetMs: 10_000 });
  const index = await loadUsageIndex(indexPath);
  const agent = usageSummary(index, { days: 30 }).agents.find((item) => item.agentId === "office-raccoon");
  assert.deepEqual([agent.sessions, agent.tokens.input, agent.tokens.output, agent.tokens.total], [1, 2_000, 500, 2_500]);
  assert.deepEqual([agent.costUsd, agent.unpricedTokens], [0, 2_500], "no model is recorded, so tokens stay unpriced");
  const detail = usageForAgent(index, "office-raccoon", { days: 30 });
  assert.deepEqual(detail.topSkills.map((skill) => [skill.name, skill.count, skill.confidence]), [["opc-alpha", 1, "reported"]]);
  assert.equal(detail.topProjects[0].name, "raccoon-project");
  const stored = await readFile(indexPath, "utf8");
  assert.doesNotMatch(stored, /MSGTEXT|ZZ9/u);
});
