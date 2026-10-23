import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startTestServer } from "./fixtures/server.mjs";
import { writeFixtureFile } from "./fixtures/smartorder.mjs";

const POSIX = process.platform !== "win32";
const skill = (name) => `---\nname: ${name}\ndescription: ${name} fixture\n---\n# ${name}\n`;
const line = (value) => `${JSON.stringify(value)}\n`;

/** Two Agents with a shared skill used today, an unknown skill folder, a few secrets and a CLI. */
async function createV020Home(home) {
  await writeFixtureFile(home, ".claude/skills/demo/SKILL.md", skill("demo"));
  await writeFixtureFile(home, ".codex/skills/demo/SKILL.md", skill("demo"));
  await writeFixtureFile(home, ".codex/skills/idle/SKILL.md", skill("idle"));
  await writeFixtureFile(home, ".claude/projects/-work-p/s.jsonl", line({
    type: "assistant",
    timestamp: new Date(Date.now() - 60_000).toISOString(),
    cwd: "/work/p",
    message: { id: "m1", model: "claude-sonnet-5-5", usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: "tool_use", id: "t1", name: "Skill", input: { skill: "demo" } }] },
  }));
  await writeFixtureFile(home, ".zcode/skills/z1/SKILL.md", skill("z1"));
  await writeFixtureFile(home, ".npmrc", "//registry.npmjs.org/:_authToken=ZZ9v020npmtoken0123456\n");
  await writeFixtureFile(home, ".config/gh/hosts.yml", "github.com:\n    user: someone\n");
  await chmod(await writeFixtureFile(home, ".local/bin/whyai", "#!/usr/bin/env node\n// YAI CLI launcher, api_key=ZZ9v020desc0123456\n"), 0o755);
}

test("v0.2 routes: new Agents, discovery, secrets, totals, sort fields, CLI inventory and update plans", { timeout: 60_000, skip: !POSIX }, async (context) => {
  const home = await mkdtemp(path.join(tmpdir(), "v020-routes-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await createV020Home(home);
  const { request, requestJson } = await startTestServer(context, home);
  const bodies = [];
  const json = async (label, pathname, options) => {
    const response = await request(pathname, options);
    const body = await response.text();
    bodies.push({ label, body });
    return { status: response.status, json: JSON.parse(body) };
  };
  const post = (label, pathname, payload, headers = {}) => json(label, pathname, { method: "POST", body: JSON.stringify(payload), headers });

  // §1: the first start is the baseline; an Agent installed later is new until acknowledged.
  const first = await requestJson("/api/config");
  assert.ok(["claude", "codex"].every((id) => first.knownAgentIds.includes(id)));
  assert.deepEqual(first.newAgentIds, []);
  await writeFixtureFile(home, ".gemini/skills/g1/SKILL.md", skill("g1"));
  assert.ok((await requestJson("/api/config")).newAgentIds.includes("gemini"));

  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await requestJson("/api/usage/status")).state === "complete") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const scan = (await json("scan", "/api/scan?force=1")).json;
  const agent = (id) => scan.agents.find((item) => item.id === id);
  assert.deepEqual([agent("gemini").isNew, agent("claude").isNew], [true, false]);
  // §3: sort metadata on skills.
  const demo = scan.skills.find((item) => item.name === "demo");
  assert.ok(Date.parse(demo.installedAt) && Date.parse(demo.updatedAt));
  assert.ok(demo.instances.every((instance) => Date.parse(instance.createdAt)));
  assert.deepEqual([typeof demo.lastUsedAt, demo.uses30d, demo.usesAll], ["string", 1, 1]);
  assert.deepEqual([scan.skills.find((item) => item.name === "idle").lastUsedAt, scan.skills.find((item) => item.name === "idle").uses30d], [null, 0]);

  const acknowledged = await post("acknowledge", "/api/agents/acknowledge", { ids: ["gemini"] });
  assert.equal(acknowledged.status, 200);
  assert.ok(acknowledged.json.knownAgentIds.includes("gemini"));
  assert.deepEqual(acknowledged.json.newAgentIds, []);
  assert.equal((await requestJson("/api/scan?force=1")).agents.find((item) => item.id === "gemini").isNew, false);
  assert.deepEqual([(await post("acknowledge:bad", "/api/agents/acknowledge", {})).status], [400]);

  // Discovery, then dismissing a candidate through the config.
  const discovered = (await json("discover", "/api/agents/discover")).json;
  assert.deepEqual(discovered.candidates.map((candidate) => [candidate.id, candidate.path, candidate.skillCount]), [["zcode", "~/.zcode/skills", 1]]);
  const config = await requestJson("/api/config");
  const saved = await requestJson("/api/config", { method: "PUT", body: JSON.stringify({ ...config, ignoredDiscoveries: ["~/.zcode/skills"] }) });
  assert.deepEqual(saved.ignoredDiscoveries, ["~/.zcode/skills"]);
  assert.ok(saved.knownAgentIds.includes("gemini"), "saving the config keeps known Agents");
  assert.deepEqual((await requestJson("/api/agents/discover")).candidates, []);

  // §6: secrets by key name and storage only.
  const secrets = (await json("secrets", "/api/secrets")).json;
  assert.deepEqual(secrets.items.map((item) => [item.service, item.keyName, item.storage]).sort(), [["GitHub", "登录令牌", "keychain"], ["npm（registry.npmjs.org）", "_authToken", "credential-file"]]);
  assert.ok(secrets.items.every((item) => typeof item.remedy?.prompt === "string"));

  // §7: totals for every window in one response.
  const totals = (await json("totals", "/api/usage/totals")).json;
  assert.deepEqual(totals.windows.map((window) => [window.id, window.tokens.total]), [["today", 110], ["7", 110], ["30", 110], ["90", 110], ["all", 110]]);
  assert.equal(totals.status.state, "complete");

  // §12: the CLI list has the lark-cli deep card first, then every inventoried command.
  const cli = (await json("cli-tools", "/api/cli-tools")).json;
  assert.equal(cli.tools[0].id, "lark-cli");
  const whyai = cli.tools.find((tool) => tool.id === "whyai");
  assert.deepEqual([whyai.path, whyai.kind, whyai.interpreter, whyai.aiRelated], ["~/.local/bin/whyai", "script", "node", true]);
  assert.match(whyai.description, /api_key=••••••/u);
  assert.deepEqual([cli.summary.total, cli.summary.aiRelated >= 2, cli.summary.deep], [cli.tools.length, true, 1]);

  // §2: plans need a checked update; apply needs the confirmation header; unknown ids are 404.
  assert.deepEqual([(await post("plan:missing", "/api/agent-versions/plan", { id: "codex-cli" })).json.code], ["not-found"]);
  const noHeader = await post("apply:no-header", "/api/agent-versions/apply", { planId: "x", confirm: true });
  assert.deepEqual([noHeader.status, noHeader.json.code], [400, "confirm-required"]);
  const offline = await post("apply:offline", "/api/agent-versions/apply", { planId: "x", confirm: true }, { "x-skill-manager-confirm": "yes" });
  assert.deepEqual([offline.status, offline.json.code], [409, "updates-offline"]);
  assert.equal((await post("open:missing", "/api/agent-versions/open", { id: "cursor-app" })).status, 404);

  assert.deepEqual(bodies.filter((item) => /ZZ9/u.test(item.body)).map((item) => item.label), []);
  assert.deepEqual(bodies.filter((item) => item.body.includes(home)).map((item) => item.label), []);
  for (const [pathname, method] of [["/api/secrets", "GET"], ["/api/agents/discover", "GET"], ["/api/usage/totals", "GET"], ["/api/agents/acknowledge", "POST"], ["/api/agent-versions/plan", "POST"]]) {
    const crossSite = await request(pathname, { method, ...(method === "POST" ? { body: "{}" } : {}), headers: { "Sec-Fetch-Site": "cross-site" } });
    assert.equal(crossSite.status, 403, pathname);
  }
  assert.equal((await request("/api/agents/acknowledge", { method: "POST", body: "{}", headers: { Origin: "https://evil.example.test" } })).status, 403);
});
