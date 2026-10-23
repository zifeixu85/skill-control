import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "smol-toml";
import { MASK, maskServerConfig, maskUrl, scrubTokens } from "../server/config-mask.mjs";
import { CODEX_PLANTED_TOML, PLANT_PATTERN } from "./fixtures/planted.mjs";

test("masks every planted secret position in MCP definitions and keeps safe values", () => {
  const servers = parse(CODEX_PLANTED_TOML).mcp_servers;
  const local = maskServerConfig(servers.planted);
  const remote = maskServerConfig(servers["remote-planted"]);
  const serialized = JSON.stringify({ local, remote });
  assert.doesNotMatch(serialized, PLANT_PATTERN);

  assert.equal(local.command, "/usr/local/bin/planted-server");
  assert.equal(local.cwd, "/srv/planted");
  assert.equal(local.tool_timeout_sec, 45);
  assert.deepEqual(local.args, [
    "--port",
    "8080",
    `API_KEY=${MASK}`,
    "--header",
    `X-Token: ${MASK}`,
    `Authorization: ${MASK}`,
    "--token",
    MASK,
    `--secret=${MASK}`,
    `https://${MASK}@api.example.test/v1?${MASK}`,
    `https://hooks.example.test/services/${MASK}/x`,
    "-e",
    `ANY=${MASK}`,
  ]);
  assert.deepEqual(local.env, {
    API_TOKEN: MASK,
    DATA_DIR: "/var/lib/planted",
    NESTED_REF: "${SAFE_REF}",
    RAW: MASK,
  });

  assert.equal(remote.url, `https://${MASK}@remote.example.test/mcp/${MASK}?${MASK}`);
  assert.equal(remote.bearer_token, MASK);
  assert.equal(remote.bearer_token_env_var, "REMOTE_TOKEN");
  assert.equal(remote.startup_timeout_sec, 30);
  assert.deepEqual(remote.http_headers, {
    Authorization: MASK,
    "X-Custom": MASK,
    "X-Env": "${SAFE_HEADER_ENV}",
  });
  assert.deepEqual(remote.oauth, { client_id: MASK, client_secret: MASK });
  assert.deepEqual(remote.nested, { deeper: { api_key: MASK } });
});

test("keeps pure environment references in headers, including Bearer references", () => {
  const masked = maskServerConfig({
    headers: { A: "${TOKEN}", B: "$TOKEN", C: "{env:TOKEN}", D: "${env:TOKEN}", E: "Bearer ${TOKEN}", F: "application/json" },
    env_http_headers: { Authorization: "GITHUB_TOKEN" },
    enabled: false,
  });
  assert.deepEqual(masked.headers, {
    A: "${TOKEN}",
    B: "$TOKEN",
    C: "{env:TOKEN}",
    D: "${env:TOKEN}",
    E: "Bearer ${TOKEN}",
    F: MASK,
  });
  assert.deepEqual(masked.env_http_headers, { Authorization: "GITHUB_TOKEN" });
  assert.equal(masked.enabled, false);
});

test("scrubs token shapes in free text and masks URL credentials", () => {
  const scrubbed = scrubTokens(
    "use Bearer abcdef1234567890xyz and sk-proj-abcdefgh12345678 or ghp_abcdefghijklmnop1234 and github_pat_11ABCDEFG0123456789_x " +
      "xoxb-1234-abcdefgh eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl task-runner",
  );
  assert.doesNotMatch(scrubbed, /abcdef1234567890xyz|proj-abcdefgh|ghp_|github_pat_|xoxb-|eyJhbGci/u);
  assert.match(scrubbed, /task-runner/u);
  assert.equal(scrubTokens("Basic concepts of bearer tokens"), "Basic concepts of bearer tokens");
  assert.equal(maskUrl("https://plain.example.test/mcp/v1"), "https://plain.example.test/mcp/v1");
  assert.equal(maskUrl("https://a:b@x.test/p?q=1#frag"), `https://${MASK}@x.test/p?${MASK}#${MASK}`);
});

test("masks pathological values in bounded time", () => {
  const started = performance.now();
  maskServerConfig({
    args: [`--${"key".repeat(100_000)}=v`, `Bearer ${"a".repeat(300_000)}`, `${"A".repeat(200_000)}=x`],
    env: Object.fromEntries(Array.from({ length: 2_000 }, (_, index) => [`K${index}`, "v"])),
    url: `https://example.test/${"a/".repeat(50_000)}?x=1`,
  });
  scrubTokens(`Bearer ${"x".repeat(500_000)} eyJ${"a".repeat(100_000)}.`);
  assert.ok(performance.now() - started < 2000);
});

test("bounds the work on YAML alias bombs", async () => {
  const { default: yaml } = await import("js-yaml");
  const levels = ["a: &a [x, x, x, x, x, x, x, x, x, x]"];
  for (let level = 1; level < 9; level += 1) {
    const prev = String.fromCharCode(96 + level);
    const name = String.fromCharCode(97 + level);
    levels.push(`${name}: &${name} [${Array(10).fill(`*${prev}`).join(", ")}]`);
  }
  const bomb = yaml.load(levels.join("\n"), { json: true });
  const started = performance.now();
  const masked = maskServerConfig(bomb);
  assert.ok(performance.now() - started < 3000);
  assert.ok(JSON.stringify(masked).length < 2_000_000);
});
