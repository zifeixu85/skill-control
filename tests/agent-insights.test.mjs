import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AGENT_FILE_LIMIT, clearAgentFileRegistry, listAgentFiles, readAgentFile } from "../server/agent-files.mjs";
import { listAgentTools } from "../server/agent-tools.mjs";
import { parseToolsetsSource } from "../server/hermes-toolsets.mjs";
import { scanIntegrations } from "../server/integrations.mjs";
import { createOpenClawHome } from "./fixtures/claw-hermes.mjs";
import { createAgentFilesHome } from "./fixtures/insights.mjs";
import { writeFixtureFile } from "./fixtures/smartorder.mjs";

const POSIX = process.platform !== "win32";

async function setup(context) {
  const home = await mkdtemp(path.join(tmpdir(), "agent-insights-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await createAgentFilesHome(home);
  return { home, options: { homeDirectory: home, homes: [home] } };
}

const names = (listing, groupId) => listing.groups.find((group) => group.id === groupId)?.files.map((file) => file.name) || [];

test("lists agent persona, memory and rule files and reads them redacted", async (context) => {
  const { home, options } = await setup(context);
  const codex = await listAgentFiles("codex", options);
  assert.deepEqual(names(codex, "instructions"), ["AGENTS.md"]);
  assert.deepEqual(names(codex, "rules"), ["default.rules"]);
  // FIFOs and credential-looking names are never listed; auth.json is not part of any group.
  assert.deepEqual(names(codex, "memories"), ["MEMORY.md"]);
  assert.deepEqual(names(codex, "memory-summaries"), ["2026-10-01.md"]);
  const agentsMd = codex.groups[0].files[0];
  assert.equal(agentsMd.kind, "instructions");
  assert.equal(agentsMd.displayPath, "~/.codex/AGENTS.md");
  assert.match(agentsMd.id, /^[a-f0-9]{24}$/u);
  const content = await readAgentFile(agentsMd.id, options);
  assert.equal(content.language, "md");
  assert.ok(content.redactions >= 1);
  assert.doesNotMatch(content.text, /ZZ9/u);
  assert.match(content.text, /Work in `~` only/u);
  const rules = await readAgentFile(codex.groups[1].files[0].id, options);
  assert.equal(rules.language, "text");
  assert.doesNotMatch(rules.text, /ZZ9/u);

  const claude = await listAgentFiles("claude", options);
  assert.deepEqual(names(claude, "instructions"), ["CLAUDE.md"]);
  assert.deepEqual(names(claude, "memories"), ["MEMORY.md"]);
  assert.deepEqual(names(claude, "rules"), ["security.md"], "a rule linked outside ~/.claude is skipped");
  assert.deepEqual(names(claude, "agents"), ["reviewer.md"]);
  assert.deepEqual(names(claude, "commands"), ["deploy.md"]);

  const workbuddy = await listAgentFiles("workbuddy", options);
  assert.deepEqual(
    workbuddy.groups[0].files.map((file) => [file.name, file.kind]),
    [["SOUL.md", "persona"], ["IDENTITY.md", "identity"], ["USER.md", "user"], ["MEMORY.md", "memory"]],
  );

  const hermes = await listAgentFiles("hermes", options);
  assert.deepEqual(hermes.profiles, ["default", "research"]);
  assert.deepEqual(names(hermes, "persona"), ["SOUL.md"]);
  assert.deepEqual(names(hermes, "memories"), ["MEMORY.md"]);
  const cron = await readAgentFile(hermes.groups.find((group) => group.id === "cron").files[0].id, options);
  assert.equal(cron.language, "json");
  const jobs = JSON.parse(cron.text).jobs;
  assert.deepEqual(jobs.map((job) => [job.name, job.schedule, job.enabled]), [["Daily digest", "every day 9:00", true]]);
  assert.doesNotMatch(cron.text, /prompt|ZZ9/u);
  const research = await listAgentFiles("hermes", { ...options, profile: "research" });
  assert.equal(research.profile, "research");
  assert.deepEqual(names(research, "persona"), ["SOUL.md"]);

  // Without an agent parameter every agent's workspace and agents/<id>/ folder is listed.
  const openclaw = await listAgentFiles("openclaw", options);
  assert.deepEqual(openclaw.agents, ["main", "writer"]);
  assert.deepEqual(names(openclaw, "workspace:main"), ["SOUL.md", "IDENTITY.md"]);
  assert.deepEqual(names(openclaw, "workspace:writer"), ["AGENTS.md"]);
  const agentState = openclaw.groups.find((group) => group.id === "agent-state:main");
  assert.equal(agentState.note, "由 LumiClaw 写入");
  assert.deepEqual(agentState.files.map((file) => [file.name, file.kind]), [["LESSONS.md", "lessons"]]);
  assert.deepEqual(names(openclaw, "state"), ["AGENTS.md", "LUMICLAW.md"]);
  const writer = await listAgentFiles("openclaw", { ...options, agent: "writer" });
  assert.deepEqual(names(writer, "workspace"), ["AGENTS.md"]);

  for (const listing of [codex, claude, workbuddy, hermes, research, openclaw, writer]) {
    for (const file of listing.groups.flatMap((group) => group.files)) {
      const read = await readAgentFile(file.id, options);
      assert.doesNotMatch(read.text, /ZZ9/u, `${listing.agentId}:${file.name}`);
      assert.equal(read.text.includes(home), false, file.name);
    }
  }
  assert.equal(JSON.stringify([codex, claude, workbuddy, hermes, openclaw]).includes(home), false);
});

test("agent file ids survive a restart, unknown ids are refused and big files are truncated", async (context) => {
  const { home, options } = await setup(context);
  await writeFile(path.join(home, ".codex", "memories", "big.md"), `${"x".repeat(AGENT_FILE_LIMIT + 10)}\n`);
  const codex = await listAgentFiles("codex", options);
  const big = codex.groups.find((group) => group.id === "memories").files.find((file) => file.name === "big.md");
  clearAgentFileRegistry();
  const read = await readAgentFile(big.id, options);
  assert.equal(read.truncated, true);
  assert.equal(read.text.length, AGENT_FILE_LIMIT);
  await assert.rejects(readAgentFile("0".repeat(24), options), (error) => error.statusCode === 404);
  await assert.rejects(readAgentFile("../../etc/passwd", options), (error) => error.statusCode === 404);
  if (POSIX) {
    // A listed file later replaced by a link outside its root is refused at read time.
    const memory = codex.groups.find((group) => group.id === "memories").files.find((file) => file.name === "MEMORY.md");
    await rm(path.join(home, ".codex", "memories", "MEMORY.md"));
    const { symlink } = await import("node:fs/promises");
    await symlink(path.join(home, "outside", "secret.md"), path.join(home, ".codex", "memories", "MEMORY.md"));
    await assert.rejects(readAgentFile(memory.id, options), (error) => error.statusCode === 404);
  }
});

test("lists tools: Codex features and connectors, Claude permissions, WorkBuddy caches, Hermes toolsets", async (context) => {
  const { home, options } = await setup(context);
  await writeFixtureFile(home, ".codex/config.toml", `
model = "gpt-5"
[features]
memories = true
js_repl = false
[mcp_servers.docs]
command = "npx"
args = ["-y", "docs-mcp", "--token", "ZZ9codextoolarg34"]
`);
  await writeFixtureFile(home, ".codex/cache/codex_apps_tools/cache.json", JSON.stringify({
    tools: [
      { connector_id: "gmail", connector_name: "Gmail", tool_namespace: "gmail", tool: { name: "search_email", title: "Search email" } },
      { connector_id: "gmail", connector_name: "Gmail", tool: { name: "send_email" } },
    ],
  }));
  const integrations = (await scanIntegrations(home)).payload;
  const tools = async (agentId) => listAgentTools(agentId, { ...options, integrations });
  const group = (result, id) => result.groups.find((item) => item.id === id);

  const codex = await tools("codex");
  assert.deepEqual(group(codex, "features").items.map((item) => [item.name, item.enabled]), [["memories", true], ["js_repl", false]]);
  assert.deepEqual(group(codex, "connectors").items.map((item) => [item.name, item.tools]), [["Gmail", ["Search email", "send_email"]]]);
  assert.match(group(codex, "mcp").items[0].description, /未缓存工具清单/u);

  const claude = await tools("claude");
  const permissions = group(claude, "permissions").items;
  assert.deepEqual(permissions[0], { name: "默认模式", description: "acceptEdits", kind: "permission", enabled: null });
  assert.deepEqual(permissions.slice(1).map((item) => item.enabled), [true, true, null, false]);
  assert.match(permissions[1].name, /^Bash\(npm test\)$/u);
  assert.deepEqual(group(claude, "subagents").items.map((item) => [item.name, item.kind]), [["reviewer", "subagent"]]);
  assert.deepEqual(group(claude, "commands").items.map((item) => item.name), ["/deploy"]);

  const workbuddy = await tools("workbuddy");
  assert.deepEqual(workbuddy.groups[0].items.map((item) => item.name), ["search_docs"]);
  assert.equal(workbuddy.groups[0].label, "MCP 工具（服务 9a910600）");
  assert.deepEqual(group(workbuddy, "connectors").items.map((item) => [item.name, item.enabled]), [["feishu", true], ["baidu-netdisk", false]]);

  const hermes = await tools("hermes");
  const toolsets = Object.fromEntries(group(hermes, "toolsets").items.map((item) => [item.name, item.enabled]));
  assert.deepEqual(toolsets, { "hermes-cli": true, web: true, safe: false });
  assert.deepEqual(group(hermes, "tools").items.map((item) => item.name), ["read_file", "terminal", "web_extract", "web_search"]);
  assert.equal(group(hermes, "permissions").items.length, 1);
  assert.deepEqual(group(hermes, "mcp").items.map((item) => item.name), ["hermcp"]);

  const all = JSON.stringify([codex, claude, workbuddy, hermes]);
  assert.doesNotMatch(all, /ZZ9/u);
  assert.equal(all.includes(home), false);
});

test("lists OpenClaw tool policy and parses Hermes toolsets statically", async (context) => {
  const home = await mkdtemp(path.join(tmpdir(), "openclaw-tools-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await createOpenClawHome(home);
  await writeFixtureFile(home, ".openclaw/openclaw.json", `{
    // tool policy
    tools: { profile: "coding", allow: ["exec"], alsoAllow: ["browser"], deny: ["gateway"], web: { search: { enabled: true, provider: "brave", apiKey: "ZZ9octoolkey35" } } },
    browser: { enabled: false },
  }`);
  const result = await listAgentTools("openclaw", { homeDirectory: home, homes: [home], integrations: { plugins: [], mcpServers: [] } });
  const policy = result.groups.find((group) => group.id === "policy").items;
  assert.deepEqual(
    policy.map((item) => [item.name, item.enabled]),
    [["工具档位", null], ["exec", true], ["browser", true], ["gateway", false], ["web.search", true], ["浏览器", false]],
  );
  assert.doesNotMatch(JSON.stringify(result), /ZZ9/u);

  const parsed = parseToolsetsSource(`
_A = [
    "one",  # first
    "two",
]
TOOLSETS = {
    "x": {
        "description": "X " "tools",
        "tools": _A + ["three"],
        "includes": ["y"],
    },
    "y": { "description": 'Y', "tools": [], "includes": [] },
}
os.system("never executed")
`);
  assert.deepEqual(parsed.get("x"), { description: "X tools", tools: ["three", "one", "two"], includes: ["y"] });
  assert.deepEqual([...parsed.keys()], ["x", "y"]);
});
