import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "smol-toml";
import { maskServerConfig } from "../server/config-mask.mjs";
import { scrubTokens } from "../server/fs-safe.mjs";
import {
  ALL_MCP_NAMES,
  CLAUDE_MCP_CASES,
  CODEX_MCP_CASES,
  MARKER,
  MARKER_PATTERN,
  OTHER_MCP_CASES,
  SKILL_TEXT,
  createLeakProbeHome,
} from "./fixtures/leak-cases.mjs";
import {
  createHermesHome,
  createLumiClawHome,
  createOpenClawHome,
  createQClawHome,
} from "./fixtures/claw-hermes.mjs";
import { createAgentFilesHome, createTranscriptsHome } from "./fixtures/insights.mjs";
import { startTestServer } from "./fixtures/server.mjs";
import { writeFixtureFile } from "./fixtures/smartorder.mjs";

const leaksIn = (value) => [...new Set(String(value).match(MARKER_PATTERN) || [])];

test("default-deny masking hides every planted MCP secret shape", async (context) => {
  const home = await mkdtemp(path.join(tmpdir(), "leak-cases-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await createLeakProbeHome(home);
  const codex = parse(await readFile(path.join(home, ".codex", "config.toml"), "utf8")).mcp_servers;
  const cases = [
    ...CODEX_MCP_CASES.map(([name]) => [name, codex[name]]),
    ...CLAUDE_MCP_CASES,
    ...Object.values(OTHER_MCP_CASES),
  ];
  for (const [name, config] of cases) {
    assert.deepEqual(leaksIn(JSON.stringify(maskServerConfig(config))), [], name);
  }
  assert.deepEqual(leaksIn(scrubTokens(SKILL_TEXT)), []);
  assert.match(scrubTokens(SKILL_TEXT), /Basic concepts of bearer tokens/u);
});

test("no planted secret or home path appears in any local API response", async (context) => {
  const home = await mkdtemp(path.join(tmpdir(), "leak-probe-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await createLeakProbeHome(home);
  const { request } = await startTestServer(context, home);
  const responses = [];
  const get = async (label, pathname) => {
    const response = await request(pathname);
    const body = await response.text();
    responses.push({ label, status: response.status, body });
    return { status: response.status, body };
  };

  for (const name of ALL_MCP_NAMES) {
    const { status } = await get(`mcp:${name}`, `/api/config-detail?kind=mcp&id=${encodeURIComponent(name)}`);
    assert.equal(status, 200, name);
  }
  for (const id of ["codex", "claude", "workbuddy", "gemini", "cursor"]) {
    await get(`agent:${id}`, `/api/config-detail?kind=agent&id=${id}`);
  }
  for (const id of ["claude:p1@market", "claude:p2@market"]) {
    await get(`plugin:${id}`, `/api/config-detail?kind=plugin&id=${encodeURIComponent(id)}`);
  }
  const capabilities = JSON.parse((await get("capabilities", "/api/capabilities")).body);
  for (const item of capabilities.products.flatMap((product) => product.items)) {
    await get(`expert:${item.name}`, `/api/config-detail?kind=expert&id=${item.id}`);
    const listing = JSON.parse((await get(`files:${item.name}`, `/api/capability-files?capabilityId=${item.id}`)).body);
    for (const entry of (listing.entries || []).filter((file) => file.type === "file")) {
      await get(`file:${item.name}:${entry.path}`, `/api/capability-file?capabilityId=${item.id}&path=${encodeURIComponent(entry.path)}`);
    }
    for (const probe of [".mcp.json", ".env", ".codebuddy-plugin/../.mcp.json"]) {
      const { status } = await get(`probe:${item.name}:${probe}`, `/api/capability-file?capabilityId=${item.id}&path=${encodeURIComponent(probe)}`);
      assert.equal(status, 400, probe);
    }
  }
  const scan = JSON.parse((await get("scan", "/api/scan?force=1")).body);
  const skill = scan.skills.find((item) => item.name === "leaky");
  await get("skill", `/api/config-detail?kind=skill&id=${skill.id}&instance=${skill.instances[0].id}`);
  await get("integrations", "/api/integrations?force=1");
  await get("mcp", "/api/mcp");

  const leaks = responses
    .map((response) => ({ label: response.label, markers: leaksIn(response.body) }))
    .filter((item) => item.markers.length);
  assert.deepEqual(leaks, [], `planted ${MARKER} markers leaked`);
  const homeLeaks = responses.filter((response) => response.body.includes(home)).map((response) => response.label);
  assert.deepEqual(homeLeaks, []);

  const claude = JSON.parse(responses.find((response) => response.label === "agent:claude").body);
  const rules = claude.rows.find((row) => row.label === "允许规则").value;
  assert.match(rules, /Bash\(npm test\)/u);
  assert.match(rules, /WebFetch\(domain:example\.test\)/u);
  const codexDetail = JSON.parse(responses.find((response) => response.label === "mcp:t03_envtable").body);
  assert.match(codexDetail.files[0].text, /LOG_LEVEL = "debug"/u);
  assert.match(codexDetail.files[0].text, /postgres:\/\/••••••@h\/db/u);
});

test("no planted Hermes, OpenClaw, QClaw or LumiClaw secret appears in any local API response", async (context) => {
  const home = await mkdtemp(path.join(tmpdir(), "leak-claw-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await createHermesHome(home);
  await createOpenClawHome(home);
  await createQClawHome(home);
  await createLumiClawHome(home);
  const { request } = await startTestServer(context, home);
  const responses = [];
  const get = async (label, pathname) => {
    const response = await request(pathname);
    const body = await response.text();
    responses.push({ label, status: response.status, body });
    return { status: response.status, body };
  };

  const config = JSON.parse((await get("config", "/api/config")).body);
  const detected = config.agents.map((agent) => agent.id);
  for (const id of ["hermes", "openclaw", "qclaw"]) {
    assert.ok(detected.includes(id), id);
    const { status } = await get(`agent:${id}`, `/api/config-detail?kind=agent&id=${id}`);
    assert.equal(status, 200, id);
  }
  for (const name of ["hermcp", "ocmcp"]) {
    const { status } = await get(`mcp:${name}`, `/api/config-detail?kind=mcp&id=${name}`);
    assert.equal(status, 200, name);
  }
  const capabilities = JSON.parse((await get("capabilities", "/api/capabilities")).body);
  const items = capabilities.products
    .filter((product) => ["hermes", "openclaw", "qclaw"].includes(product.id))
    .flatMap((product) => product.items);
  assert.ok(items.length >= 4);
  for (const item of items) {
    await get(`expert:${item.name}`, `/api/config-detail?kind=expert&id=${item.id}`);
    const listing = JSON.parse((await get(`files:${item.name}`, `/api/capability-files?capabilityId=${item.id}`)).body);
    for (const entry of (listing.entries || []).filter((file) => file.type === "file")) {
      await get(`file:${item.name}:${entry.path}`, `/api/capability-file?capabilityId=${item.id}&path=${encodeURIComponent(entry.path)}`);
    }
    for (const probe of [".env", "auth.json", "channel_directory.json", "credentials/oauth.json", "auth-profiles.json", "../.env"]) {
      const { status } = await get(`probe:${item.name}:${probe}`, `/api/capability-file?capabilityId=${item.id}&path=${encodeURIComponent(probe)}`);
      assert.equal(status, 400, `${item.name} ${probe}`);
    }
  }
  const scan = JSON.parse((await get("scan", "/api/scan?force=1")).body);
  for (const skill of scan.skills) {
    for (const instance of skill.instances.filter((item) => ["hermes", "openclaw", "qclaw"].includes(item.agentId))) {
      await get(`skill:${instance.agentId}:${skill.name}`, `/api/config-detail?kind=skill&id=${skill.id}&instance=${instance.id}`);
    }
  }
  const integrations = JSON.parse((await get("integrations", "/api/integrations?force=1")).body);
  assert.deepEqual(integrations.relatedProducts.map((product) => product.id), ["lumiclaw"]);
  const clawPlugins = integrations.plugins.filter((item) => ["hermes", "openclaw", "qclaw"].includes(item.agentId));
  assert.deepEqual(clawPlugins.map((plugin) => plugin.agentId).sort(), ["hermes", "openclaw", "qclaw"]);
  for (const plugin of clawPlugins) {
    const id = `${plugin.agentId}:${plugin.id}`;
    const { status } = await get(`plugin:${id}`, `/api/config-detail?kind=plugin&id=${encodeURIComponent(id)}`);
    assert.equal(status, 200, id);
  }
  await get("mcp", "/api/mcp");
  await get("activity", "/api/agents/activity?force=1");

  const leaks = responses
    .map((response) => ({ label: response.label, markers: leaksIn(response.body) }))
    .filter((item) => item.markers.length);
  assert.deepEqual(leaks, [], `planted ${MARKER} markers leaked`);
  const homeLeaks = responses.filter((response) => response.body.includes(home)).map((response) => response.label);
  assert.deepEqual(homeLeaks, []);
  const fileReads = responses.filter((response) => response.label.startsWith("file:") && response.status === 200);
  assert.ok(fileReads.length >= 4, "workspace and profile files were read through the redactor");
  assert.ok(responses.filter((response) => response.label.startsWith("skill:")).length >= 20);
});

test("no planted secret or message text leaks from agent files, tools, usage, health or icons", async (context) => {
  const home = await mkdtemp(path.join(tmpdir(), "leak-insights-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await createAgentFilesHome(home);
  await createTranscriptsHome(home);
  await createQClawHome(home);
  await createLumiClawHome(home);
  await writeFixtureFile(home, ".codex/config.toml", '[features]\nmemories = true\n[mcp_servers.docs]\ncommand = "npx"\nargs = ["-y", "docs", "--api-key=ZZ9codexmcpkey37"]\n');
  if (process.platform === "darwin") {
    // A real icns→png conversion through sips, from an app in the synthetic Applications folder.
    await writeFixtureFile(home, "Applications/Codex.app/Contents/Info.plist", '<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>com.openai.codex</string><key>CFBundleIconFile</key><string>electron</string></dict></plist>');
    const png = await readFile(new URL("../resources/icon.png", import.meta.url));
    await writeFixtureFile(home, "Applications/Codex.app/Contents/Resources/electron.icns", png);
  }
  const { request } = await startTestServer(context, home);
  const responses = [];
  const get = async (label, pathname) => {
    const response = await request(pathname);
    const isImage = String(response.headers.get("content-type") || "").startsWith("image/");
    const body = isImage ? "" : await response.text();
    if (isImage) await response.arrayBuffer();
    responses.push({ label, status: response.status, body, contentType: response.headers.get("content-type") });
    return { status: response.status, body, contentType: response.headers.get("content-type") };
  };

  const listings = [];
  for (const query of ["codex", "claude", "workbuddy", "gemini", "cursor", "hermes", "hermes&profile=research", "openclaw", "openclaw&agentId=writer", "qclaw"]) {
    const { status, body } = await get(`files:${query}`, `/api/agent-files?agent=${query}`);
    assert.equal(status, 200, query);
    listings.push(JSON.parse(body));
  }
  const files = listings.flatMap((listing) => listing.groups.flatMap((group) => group.files));
  assert.ok(files.length >= 20, `listed ${files.length} files`);
  for (const file of files) {
    const { status } = await get(`file:${file.name}`, `/api/agent-file?id=${file.id}`);
    assert.equal(status, 200, file.name);
  }
  assert.equal((await get("file:bogus", `/api/agent-file?id=${"a".repeat(24)}`)).status, 404);
  assert.equal((await get("files:bad-agent", "/api/agent-files?agent=../etc")).status, 404);
  for (const agentId of ["codex", "claude", "workbuddy", "hermes", "openclaw", "qclaw"]) {
    assert.equal((await get(`tools:${agentId}`, `/api/agent-tools?agent=${agentId}`)).status, 200, agentId);
  }

  let status;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    status = JSON.parse((await get("usage:status", "/api/usage/status")).body);
    if (status.state === "complete") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(status.state, "complete");
  const summary = JSON.parse((await get("usage:summary", "/api/usage/summary?days=30")).body);
  assert.equal(summary.agents.find((agent) => agent.agentId === "claude").tokens.total, 156);
  for (const agentId of ["claude", "codex", "workbuddy", "hermes", "openclaw"]) {
    await get(`usage:agent:${agentId}`, `/api/usage/agent?id=${agentId}&days=90`);
  }
  for (const name of ["pdf", "xlsx", "lark-doc", "flat-skill", "managed-skill"]) {
    assert.equal((await get(`usage:skill:${name}`, `/api/usage/skill?name=${name}&days=90`)).status, 200);
  }
  assert.equal((await get("usage:skill:bad", "/api/usage/skill?name=%3Cscript%3E")).status, 400);
  const health = JSON.parse((await get("health", "/api/health-report?force=1")).body);
  assert.ok(health.findings.length > 0);
  const icon = await get("icon:codex", "/api/agent-icon?id=codex");
  if (process.platform === "darwin") assert.deepEqual([icon.status, icon.contentType], [200, "image/png"]);
  else assert.equal(icon.status, 404);
  assert.equal((await get("icon:claude", "/api/agent-icon?id=claude")).status, 404);

  const leaks = responses
    .map((response) => ({ label: response.label, markers: leaksIn(response.body) }))
    .filter((item) => item.markers.length);
  assert.deepEqual(leaks, [], `planted ${MARKER} markers leaked`);
  assert.deepEqual(responses.filter((response) => /MSGTEXT/u.test(response.body)).map((response) => response.label), []);
  assert.deepEqual(responses.filter((response) => response.body.includes(home)).map((response) => response.label), []);
  const stored = await readFile(path.join(home, ".agent-skill-manager", "usage-index.json"), "utf8");
  assert.doesNotMatch(stored, /MSGTEXT|ZZ9/u);

  for (const pathname of ["/api/agent-files?agent=codex", `/api/agent-file?id=${files[0].id}`, "/api/agent-tools?agent=codex", "/api/usage/summary", "/api/health-report", "/api/agent-icon?id=codex"]) {
    const crossSite = await request(pathname, { headers: { "Sec-Fetch-Site": "cross-site" } });
    assert.equal(crossSite.status, 403, pathname);
  }
});

test("refuses cross-site reads of configuration and assets", async (context) => {
  const home = await mkdtemp(path.join(tmpdir(), "leak-cross-site-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await createLeakProbeHome(home);
  const { request } = await startTestServer(context, home);
  for (const pathname of ["/api/config-detail?kind=agent&id=codex", "/api/capability-file?capabilityId=x&path=y", "/api/plugin-asset?id=x"]) {
    const crossSite = await request(pathname, { headers: { "Sec-Fetch-Site": "cross-site" } });
    assert.equal(crossSite.status, 403, pathname);
  }
  const sameSite = await request("/api/config-detail?kind=agent&id=codex", { headers: { "Sec-Fetch-Site": "same-site" } });
  assert.equal(sameSite.status, 200);
});
