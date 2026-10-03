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
import { startTestServer } from "./fixtures/server.mjs";

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
