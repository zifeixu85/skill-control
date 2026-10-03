import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { scanAgentActivity } from "../server/agents-activity.mjs";
import { buildConfigDetail } from "../server/config-detail.mjs";
import { homeVariants } from "../server/fs-safe.mjs";
import { scanHermesProfiles, readHermesActivity } from "../server/hermes.mjs";
import { buildSyncPlan, sanitizeConfig, scanAll } from "../server/local-server.mjs";
import { scanMcpInventory } from "../server/mcp-inventory.mjs";
import { readOpenClawActivity, scanOpenClawAgents, scanOpenClawPlugins } from "../server/openclaw.mjs";
import { detectRelatedProducts } from "../server/related-products.mjs";
import {
  createHermesHome,
  createLumiClawHome,
  createOpenClawHome,
  createQClawHome,
} from "./fixtures/claw-hermes.mjs";

const POSIX = process.platform !== "win32";

async function setup(context, options = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "claw-hermes-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await createHermesHome(home);
  await createOpenClawHome(home, options);
  await createQClawHome(home);
  await createLumiClawHome(home);
  if (POSIX) {
    await mkdir(path.join(home, ".agents"), { recursive: true });
    await symlink(path.join(home, "shared", "skills"), path.join(home, ".agents", "skills"));
  }
  const agent = (id, paths) => ({ id, name: id, shortName: id.slice(0, 2), color: "#8fc9ef", paths });
  const config = {
    agents: [
      agent("codex", [path.join(home, ".agents", "skills")]),
      agent("hermes", [path.join(home, ".hermes", "skills")]),
      agent("openclaw", [path.join(home, ".openclaw", "skills")]),
      agent("qclaw", [path.join(home, ".qclaw", "skills")]),
    ],
    visibleAgentIds: ["codex", "hermes", "openclaw", "qclaw"],
    primaryAgentIds: ["codex", "hermes"],
  };
  const scan = await scanAll(config, { homeDirectory: home });
  return { home, config, scan };
}

const instancesOf = (scan, agentId) =>
  scan.skills.flatMap((skill) => skill.instances.filter((instance) => instance.agentId === agentId));
const instance = (scan, agentId, name) => instancesOf(scan, agentId).find((item) => item.name === name);

test("scans Hermes skills like Hermes: nested, bundled, hub, org, external, profiles and archive", async (context) => {
  const { scan } = await setup(context);
  const names = instancesOf(scan, "hermes").map((item) => item.name).sort();
  assert.deepEqual(
    names,
    [
      "bundled-skill", "disabled-skill", "ext-skill", "flat-skill", "flat-skill", "hub-skill",
      ...(POSIX ? ["linked-skill"] : []), "nested-skill", "org-skill", "plat-skill", "prof-skill", "with-support",
    ],
  );
  assert.equal(instance(scan, "hermes", "bundled-skill").source, "hermes-bundled");
  assert.equal(instance(scan, "hermes", "bundled-skill").managed, true);
  assert.notEqual(instance(scan, "hermes", "bundled-skill").readOnly, true);
  assert.equal(instance(scan, "hermes", "hub-skill").source, "hermes-hub");
  assert.equal(instance(scan, "hermes", "hub-skill").readOnly, true);
  assert.equal(instance(scan, "hermes", "org-skill").source, "hermes-org");
  assert.equal(instance(scan, "hermes", "disabled-skill").disabled, true);
  assert.deepEqual(instance(scan, "hermes", "plat-skill").disabledOn, ["telegram"]);
  assert.equal(instance(scan, "hermes", "prof-skill").profile, "research");
  assert.equal(instance(scan, "hermes", "ext-skill").source, "hermes-external");
  const flats = instancesOf(scan, "hermes").filter((item) => item.name === "flat-skill");
  assert.equal(flats.filter((item) => item.shadowed).length, 1);
  assert.equal(flats.find((item) => item.shadowed).source, "hermes-external");
  assert.deepEqual(flats.find((item) => !item.shadowed).usage, {
    count: 7,
    lastUsedAt: "2026-09-30T10:00:00+00:00",
    state: "active",
    pinned: true,
    confidence: "recorded",
  });
  assert.deepEqual(scan.archivedSkills.map((item) => [item.name, item.archived, item.readOnly]), [["old-skill", true, true]]);
  const hermesAgent = scan.agents.find((item) => item.id === "hermes");
  assert.equal(hermesAgent.copyOnly, true);
  assert.match(hermesAgent.installRoot, /\.hermes[\\/]skills$/u);
  assert.equal(hermesAgent.productVersion, "0.20.2");
  // A shadowed external copy with another version does not make the skill "differ".
  assert.equal(scan.skills.find((skill) => skill.name === "flat-skill").primaryStatus, "ok");
});

test("scans OpenClaw and QClaw with precedence, symlink escape, ClawHub and remote metadata", async (context) => {
  const { scan } = await setup(context);
  const managedCopies = instancesOf(scan, "openclaw").filter((item) => item.name === "managed-skill");
  assert.equal(managedCopies.find((item) => !item.shadowed).source, "openclaw-managed");
  // OpenClaw keeps no usage file: SKILL.md reads in recent transcripts are an estimate for the active copy.
  assert.deepEqual(managedCopies.find((item) => !item.shadowed).usage, {
    count: 1, lastUsedAt: null, state: null, pinned: false, confidence: "inferred", windowDays: 30,
  });
  assert.equal(managedCopies.find((item) => item.shadowed).usage, undefined);
  assert.equal(managedCopies.find((item) => item.source === "openclaw-extra").shadowed, true);
  assert.equal(instance(scan, "openclaw", "clawhub-skill").source, "clawhub");
  assert.equal(instance(scan, "openclaw", "clawhub-skill").readOnly, true);
  assert.equal(instance(scan, "openclaw", "off-skill").disabled, true);
  assert.equal(instance(scan, "openclaw", "ws-skill").source, "openclaw-workspace");
  assert.deepEqual(instance(scan, "openclaw", "needs-bins").requirements, {
    bins: ["op"], anyBins: [], env: ["OP_TOKEN"], config: [], os: [], emoji: "🔐", install: ["brew"],
  });
  if (POSIX) assert.equal(instance(scan, "openclaw", "escaped-skill").hiddenByProduct, "symlink-escape");
  const openclaw = scan.agents.find((item) => item.id === "openclaw");
  assert.deepEqual(openclaw.managedBy, ["LumiClaw", "Vibe Island"]);
  assert.equal(openclaw.productVersion, "2026.4.21");

  const qclaw = scan.agents.find((item) => item.id === "qclaw");
  assert.match(qclaw.refuseInstall, /QClaw 里安装/u);
  assert.ok(instancesOf(scan, "qclaw").every((item) => item.readOnly));
  assert.deepEqual(instance(scan, "qclaw", "remote-a").remote, {
    version: "1.4.0", type: "official", installMode: "auto", effectScope: "global",
  });
  assert.equal(instance(scan, "qclaw", "remote-a").disabled, true);
  assert.equal(instance(scan, "qclaw", "bundled-a").source, "openclaw-bundled");
  const sharedName = instancesOf(scan, "qclaw").filter((item) => item.name === "shared-name");
  assert.equal(sharedName.find((item) => item.source === "qclaw-config").shadowed, true);
  assert.notEqual(sharedName.find((item) => item.source === "openclaw-bundled").shadowed, true);
});

test("collapses one physical skill shared by several products and plans copy-only installs", { skip: !POSIX }, async (context) => {
  const { scan, config } = await setup(context);
  const linked = scan.skills.find((skill) => skill.name === "linked-skill");
  assert.deepEqual([...new Set(linked.instances.map((item) => item.agentId))].sort(), ["codex", "hermes", "openclaw", "qclaw"]);
  assert.equal(new Set(linked.instances.map((item) => item.realPathId)).size, 1);

  const full = sanitizeConfig(config);
  const source = scan.skills.find((skill) => skill.name === "ext-skill").instances[0];
  const plan = await buildSyncPlan(full, scan, { sourceInstanceId: source.id, targetAgentIds: ["openclaw"], mode: "symlink" });
  assert.equal(plan.actions[0].mode, "copy");
  assert.ok(plan.warnings.some((warning) => /只支持复制/u.test(warning)));
  assert.match(plan.actions[0].destination, /\.openclaw[\\/]skills[\\/]ext-skill$/u);

  const codexSource = linked.instances.find((item) => item.agentId === "codex");
  const toCodex = await buildSyncPlan(full, scan, { sourceInstanceId: source.id, targetAgentIds: ["codex"], mode: "copy" });
  assert.ok(toCodex.actions[0].alsoVisibleTo.includes("openclaw"));
  assert.ok(toCodex.actions[0].alsoVisibleTo.includes("qclaw"));
  await assert.rejects(
    buildSyncPlan(full, scan, { sourceInstanceId: codexSource.id, targetAgentIds: ["qclaw"], mode: "copy" }),
    /QClaw 的技能由 QClaw 同步管理/u,
  );
  const hub = scan.skills.find((skill) => skill.name === "hub-skill").instances[0];
  await assert.rejects(
    buildSyncPlan(full, scan, { sourceInstanceId: hub.id, targetAgentIds: ["hermes"], mode: "copy" }),
    /Skills Hub/u,
  );
});

test("reads Hermes and OpenClaw activity without message contents", async (context) => {
  const { home } = await setup(context);
  const hermes = await readHermesActivity(home);
  assert.equal(hermes.sessions30d, 2);
  assert.equal(hermes.tokens30d, 4_500);
  assert.equal(hermes.cacheTokens30d, 100);
  const openclaw = await readOpenClawActivity("openclaw", home);
  assert.equal(openclaw.sessions30d, 1);
  assert.equal(openclaw.tokens30d, 1_500);
  assert.deepEqual([...openclaw.skillReads], [["managed-skill", 1]]);
  const activity = await scanAgentActivity(home, { agentIds: ["hermes", "openclaw", "qclaw"] });
  const byId = Object.fromEntries(activity.agents.map((item) => [item.agentId, item]));
  assert.equal(byId.hermes.basis, "tokens");
  assert.equal(byId.hermes.weight30d, 4_500 * 4);
  assert.equal(byId.openclaw.files30d, 1);
  assert.deepEqual(byId.openclaw.skillReads30d, { "managed-skill": 1 });
  assert.doesNotMatch(JSON.stringify({ hermes, openclaw: { ...openclaw, skillReads: [...openclaw.skillReads] }, activity }), /ZZ9/u);
});

test("lists profiles, OpenClaw agents, plugins, MCP servers and related products", async (context) => {
  const { home } = await setup(context);
  const hermes = await scanHermesProfiles(home);
  assert.deepEqual(hermes.items.map((item) => item.name), ["default", "research"]);
  const main = hermes.items[0];
  assert.equal(main.model, "openai-codex / gpt-5.5");
  assert.equal(main.modelHost, "api.example.test");
  assert.equal(main.cronJobs, 1);
  assert.deepEqual(main.plugins, ["demo-plugin"]);
  assert.equal(main.gateway.status, "running");
  assert.equal(main.skillCount, POSIX ? 9 : 8);

  for (const variant of ["list", "entries", "none"]) {
    const variantHome = await mkdtemp(path.join(tmpdir(), "openclaw-variant-"));
    context.after(() => rm(variantHome, { recursive: true, force: true }));
    await createOpenClawHome(variantHome, { agentsVariant: variant });
    const agents = await scanOpenClawAgents("openclaw", variantHome);
    const ids = agents.items.map((item) => item.name);
    assert.deepEqual(ids, variant === "none" ? ["main"] : ["main", "writer"], variant);
    const mainAgent = agents.items.find((item) => item.name === "main");
    assert.equal(mainAgent.displayName, "Claw");
    assert.equal(mainAgent.emoji, "🦞");
    assert.deepEqual(mainAgent.workspaceFiles.map((file) => file.name), ["SOUL.md", "IDENTITY.md"]);
    if (variant === "none") assert.equal(mainAgent.implied, true);
  }
  const qclaw = await scanOpenClawAgents("qclaw", home);
  assert.equal(qclaw.items[0].displayName, "QClaw 助手");
  const plugins = await scanOpenClawPlugins("openclaw", home);
  assert.deepEqual(plugins.plugins.map((plugin) => [plugin.id, plugin.enabled]), [["vibe-island", true]]);
  const qclawPlugins = await scanOpenClawPlugins("qclaw", home);
  assert.deepEqual(qclawPlugins.plugins.map((plugin) => plugin.source), ["openclaw-bundled"]);

  const mcp = await scanMcpInventory(home);
  assert.deepEqual(
    mcp.servers.filter((server) => ["hermes", "openclaw"].includes(server.agentId)).map((server) => [server.agentId, server.name]),
    [["hermes", "hermcp"], ["openclaw", "ocmcp"]],
  );
  const related = await detectRelatedProducts(home);
  assert.deepEqual(related.map((item) => [item.id, item.kind]), [["lumiclaw", "orchestrator"]]);
  assert.match(related[0].notes, /2 个 Agent 目录/u);
  assert.doesNotMatch(JSON.stringify({ hermes, plugins, qclawPlugins, mcp, related }, (key, value) => (value instanceof Map || value instanceof Set ? undefined : value)), /ZZ9/u);
});

test("renders Hermes, OpenClaw and QClaw configuration details without secrets", async (context) => {
  const { home } = await setup(context);
  const detailContext = { homeDirectory: home, displayHomes: await homeVariants(home) };
  const bodies = [];
  for (const id of ["hermes", "openclaw", "qclaw"]) {
    const detail = await buildConfigDetail({ kind: "agent", id }, detailContext);
    bodies.push(JSON.stringify(detail));
    assert.deepEqual(detail.files, []);
  }
  const hermes = JSON.parse(bodies[0]);
  const rows = Object.fromEntries(hermes.rows.map((item) => [item.label, item.value]));
  assert.match(rows["版本"], /0\.20\.2/u);
  assert.match(rows["模型"], /openai-codex \/ gpt-5\.5（api\.example\.test）/u);
  assert.equal(rows["已停用技能数"], "1（另有 1 个按平台停用）");
  assert.match(rows["写入审批"], /技能 开启/u);
  assert.match(rows["Curator 策略"], /30 天/u);
  assert.equal(rows["定时任务数"], "1（启用 1）");
  assert.equal(rows["审批模式"], "manual");
  assert.equal(rows["凭据文件"], ".env、auth.json（只检测存在，不读取内容）");
  const openclaw = Object.fromEntries(JSON.parse(bodies[1]).rows.map((item) => [item.label, item.value]));
  assert.match(openclaw["网关"], /local；绑定 loopback；端口 18789；认证 token/u);
  assert.match(openclaw["频道"], /telegram、discord（停用）/u);
  assert.match(openclaw["凭据文件"], /credentials、auth-profiles\.json、identity\/device-auth\.json/u);
  assert.match(openclaw["由谁写入"], /LumiClaw/u);
  const hermesMcp = await buildConfigDetail({ kind: "mcp", id: "hermcp" }, detailContext);
  assert.equal(hermesMcp.files[0].language, "yaml");
  assert.match(hermesMcp.files[0].text, /LOG_LEVEL: debug/u);
  bodies.push(JSON.stringify(hermesMcp), JSON.stringify(await buildConfigDetail({ kind: "mcp", id: "ocmcp" }, detailContext)));
  assert.doesNotMatch(bodies.join("\n"), /ZZ9/u);
});
