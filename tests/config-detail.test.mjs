import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildConfigDetail } from "../server/config-detail.mjs";
import { homeVariants } from "../server/fs-safe.mjs";
import { scanIntegrations } from "../server/integrations.mjs";
import { scanAll, scanHermesProfiles } from "../server/local-server.mjs";
import { scanWorkBuddyExperts } from "../server/workbuddy-experts.mjs";
import {
  PLANT_PATTERN,
  VISIBLE_VALUES,
  createPlantedConfigFixture,
  createPlantedPluginFixture,
} from "./fixtures/planted.mjs";
import { writeFixtureFile } from "./fixtures/smartorder.mjs";
import { createWorkBuddyExpertFixture } from "./fixtures/workbuddy.mjs";

async function setup(context) {
  const home = await mkdtemp(path.join(tmpdir(), "config-detail-test-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await createPlantedConfigFixture(home);
  await createPlantedPluginFixture(home);
  await createWorkBuddyExpertFixture(home);
  await writeFixtureFile(home, ".hermes/SOUL.md", "# Hermes\n\nUses Bearer PLANTHERMES12345678.\n");
  await writeFixtureFile(home, ".hermes/config.yaml", "model:\n  provider: openai\n  api_key: PLANT-HERMES-KEY\n");
  const skillRoot = path.join(home, ".codex", "skills");
  await writeFixtureFile(
    skillRoot,
    "detail-skill/SKILL.md",
    "---\nname: detail-skill\ndescription: Detail fixture\nversion: 1.2.3\nmetadata:\n  owner: team\n---\n# Detail\n\ntoken github_pat_PLANT0123456789abcdefghij\n",
  );
  const [integrations, experts, hermes] = await Promise.all([
    scanIntegrations(home),
    scanWorkBuddyExperts(home),
    scanHermesProfiles(home),
  ]);
  const scan = await scanAll(
    {
      agents: [{ id: "codex", name: "Codex", shortName: "CX", color: "#8fc9ef", paths: [skillRoot] }],
      visibleAgentIds: ["codex"],
    },
    { homeDirectory: home },
  );
  const capabilities = [...experts.items, ...hermes.items];
  const detailContext = {
    homeDirectory: home,
    displayHomes: await homeVariants(home),
    getCapability: async (id) => capabilities.find((item) => item.id === id) || null,
    getIntegrations: async () => integrations,
    async findSkillInstance(skillId, instanceId) {
      const skill = scan.skills.find((item) => item.id === skillId);
      const instance = skill?.instances.find((item) => item.id === instanceId);
      if (!instance) return null;
      const absolutePath = instance.path.startsWith("~/")
        ? path.join(homedir(), instance.path.slice(2))
        : instance.path;
      return { skill, instance, absolutePath };
    },
  };
  return { home, integrations, capabilities, scan, detailContext };
}

const detail = (context, query) => buildConfigDetail(query, context);

test("renders masked MCP sections for every agent that configures a server", async (context) => {
  const { detailContext, home } = await setup(context);
  const bodies = [];
  for (const name of ["planted", "remote-planted", "claudeplanted", "projplanted", "cursorplanted", "pencil", "geminiplanted"]) {
    const result = await detail(detailContext, { kind: "mcp", id: name });
    bodies.push(JSON.stringify(result));
    assert.ok(result.files.length >= 1, name);
  }
  const all = bodies.join("\n");
  assert.doesNotMatch(all, PLANT_PATTERN);
  assert.doesNotMatch(all, new RegExp(home.replaceAll("/", "\\/")));
  for (const value of VISIBLE_VALUES) assert.ok(all.includes(value.replaceAll('"', '\\"')), value);

  const planted = await detail(detailContext, { kind: "mcp", id: "planted" });
  assert.deepEqual(planted.files.map((file) => [file.label, file.language]), [
    ["Codex", "toml"],
    ["Claude Code", "json"],
  ]);
  assert.match(planted.files[0].text, /\[mcp_servers\.planted\]/u);
  assert.match(planted.files[0].text, /\[mcp_servers\.planted\.env\]/u);
  const rows = Object.fromEntries(planted.rows.map((item) => [item.label, item.value]));
  assert.equal(rows["配置在"], "Codex、Claude Code");
  assert.equal(rows["连接方式"], "本地命令（stdio）");
  assert.match(rows["提醒"], /启动参数里写着密钥/u);
  assert.match(rows["提醒"], /环境变量里写着密钥/u);

  const remote = await detail(detailContext, { kind: "mcp", id: "remote-planted" });
  const remoteRows = Object.fromEntries(remote.rows.map((item) => [item.label, item.value]));
  assert.equal(remoteRows["地址"], "remote.example.test");
  assert.match(remoteRows["提醒"], /请求头里写着密钥/u);
  const project = await detail(detailContext, { kind: "mcp", id: "projplanted" });
  assert.match(project.files[0].label, /项目 ~\/Projects\/demo/u);
  await assert.rejects(detail(detailContext, { kind: "mcp", id: "missing" }), (error) => error.statusCode === 404);
});

test("summarizes agent settings in Chinese without secrets or file contents", async (context) => {
  const { detailContext } = await setup(context);
  const results = {};
  for (const id of ["codex", "claude", "workbuddy", "gemini", "cursor"]) {
    results[id] = await detail(detailContext, { kind: "agent", id });
    assert.deepEqual(results[id].files, []);
  }
  assert.doesNotMatch(JSON.stringify(results), PLANT_PATTERN);
  const codex = Object.fromEntries(results.codex.rows.map((item) => [item.label, item.value]));
  assert.equal(codex["审批策略"], "需要时询问（on-request）");
  assert.equal(codex["沙箱模式"], "只能写当前工作区（workspace-write）");
  assert.equal(codex["推理强度"], "高（high）");
  assert.equal(codex["MCP 服务数"], "2");
  assert.equal(codex["受信任项目数"], "1");
  assert.equal(codex["Shell 环境变量"], "1 个（不显示值）");
  assert.equal(codex["Hooks 事件"], "Stop、SessionStart");
  const claude = Object.fromEntries(results.claude.rows.map((item) => [item.label, item.value]));
  assert.match(claude["允许规则"], /^Bash\(npm test\)\nBash\(curl/u);
  assert.equal(claude["默认权限模式"], "自动接受编辑（acceptEdits）");
  assert.match(claude["状态栏"], /^command：~\/bin\/statusline/u);
  assert.equal(claude["环境变量"], "1 个（不显示值）");
  const workbuddy = Object.fromEntries(results.workbuddy.rows.map((item) => [item.label, item.value]));
  assert.equal(workbuddy["已启用插件"], "1 / 2");
  assert.equal(workbuddy["沙箱规则数"], "2");
  await assert.rejects(detail(detailContext, { kind: "agent", id: "unknown" }), (error) => error.statusCode === 404);
  await assert.rejects(detail(detailContext, { kind: "bogus", id: "x" }), (error) => error.statusCode === 400);
});

test("shows expert, plugin and skill details with scrubbed files", async (context) => {
  const { detailContext, capabilities, scan } = await setup(context);
  const mine = capabilities.find((item) => item.name === "mine-expert");
  const expert = await detail(detailContext, { kind: "expert", id: mine.id });
  const expertRows = Object.fromEntries(expert.rows.map((item) => [item.label, item.value]));
  assert.equal(expertRows["技术名"], "mine-expert");
  assert.equal(expertRows["最大轮次"], "40");
  assert.equal(expertRows["依赖技能"], "mine-skill");
  assert.equal(expertRows["开场提示"], "你好，我是小初");
  assert.equal(expertRows["来源"], "我的专家");
  assert.match(expertRows["分发包"], /已打包/u);
  assert.deepEqual(expert.files.map((file) => file.path), [".codebuddy-plugin/plugin.json", "agents/mine-expert.md"]);

  const team = capabilities.find((item) => item.name === "research-team");
  const teamDetail = await detail(detailContext, { kind: "expert", id: team.id });
  assert.match(Object.fromEntries(teamDetail.rows.map((item) => [item.label, item.value]))["最大轮次"], /研究负责人：18/u);
  const hermes = capabilities.find((item) => item.productId === "hermes");
  const hermesDetail = await detail(detailContext, { kind: "expert", id: hermes.id });

  const claudePlugin = await detail(detailContext, { kind: "plugin", id: "claude:planted-plugin@market" });
  assert.deepEqual(claudePlugin.files.map((file) => file.path), [".claude-plugin/plugin.json", ".mcp.json"]);
  const workbuddyPlugin = await detail(detailContext, { kind: "plugin", id: "workbuddy:demo@workbuddy-builtin" });
  assert.match(Object.fromEntries(workbuddyPlugin.rows.map((item) => [item.label, item.value]))["名称"], /演示插件/u);

  const skill = scan.skills.find((item) => item.name === "detail-skill");
  const skillDetail = await detail(detailContext, { kind: "skill", id: skill.id, instance: skill.instances[0].id });
  const skillRows = Object.fromEntries(skillDetail.rows.map((item) => [item.label, item.value]));
  assert.equal(skillRows.version, "1.2.3");
  assert.match(skillRows.metadata, /嵌套字段/u);
  assert.equal(skillDetail.files[0].truncated, false);

  const serialized = JSON.stringify({ expert, teamDetail, hermesDetail, claudePlugin, workbuddyPlugin, skillDetail });
  assert.doesNotMatch(serialized, PLANT_PATTERN);
  assert.match(serialized, /mine-expert\.md/u);
  await assert.rejects(detail(detailContext, { kind: "plugin", id: "workbuddy:escape@workbuddy-builtin" }), (error) => error.statusCode === 404);
  await assert.rejects(detail(detailContext, { kind: "skill", id: skill.id, instance: "nope" }), (error) => error.statusCode === 404);
});
