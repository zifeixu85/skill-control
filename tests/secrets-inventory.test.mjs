import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSecretsInventory, guessService, STORAGE_TYPES } from "../server/secrets-inventory.mjs";
import { remedyForSecret } from "../server/remedies.mjs";
import { createHermesHome, createOpenClawHome, createQClawHome } from "./fixtures/claw-hermes.mjs";
import { createRaccoonHome } from "./fixtures/office-raccoon.mjs";
import { createPlantedConfigFixture } from "./fixtures/planted.mjs";
import { writeFixtureFile } from "./fixtures/smartorder.mjs";

const POSIX = process.platform !== "win32";
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const MARKERS = /ZZ9|PLANT|SECRETVALUE/u;

/** Every listed source with a planted value ("ZZ9…", "PLANT…" or "SECRETVALUE…"). */
async function createSecretsHome(home) {
  await createPlantedConfigFixture(home);
  await createHermesHome(home, { withDatabase: false });
  await createOpenClawHome(home);
  await createQClawHome(home);
  await createRaccoonHome(home);
  // Current OpenClaw logins live in SQLite (noted, never opened); per-agent legacy JSON is parsed.
  await writeFixtureFile(home, ".openclaw/agents/main/agent/openclaw-agent.sqlite", "SQLite format 3 ZZ9sqlitecontent01");
  await writeFixtureFile(home, ".openclaw/agents/main/agent/auth-profiles.json", json({ profiles: { "anthropic:me": { type: "oauth", provider: "anthropic", access: "ZZ9ocoauthaccess0123456" } } }));
  await writeFixtureFile(home, ".gemini/.env", "GEMINI_API_KEY=ZZ9geminidotenv0123456789\nDEBUG=true\nGEMINI_TIMEOUT_MS=3000\n");
  await writeFixtureFile(home, ".workbuddy/.env", "export WORKBUDDY_TOKEN='ZZ9workbuddyenv01234567'\n");
  await writeFixtureFile(home, ".config/gh/hosts.yml", "github.com:\n    oauth_token: gho_ZZ9ghoauthtoken0123456789\n    user: someone\nenterprise.example.test:\n    user: someone\n    git_protocol: https\n");
  await writeFixtureFile(home, ".npmrc", "//registry.npmjs.org/:_authToken=npm_ZZ9npmrctoken0123456789\nregistry=https://registry.npmjs.org/\n");
  await writeFixtureFile(home, ".netrc", "machine api.example.test login someone password ZZ9netrcpassword012345\n");
  await writeFixtureFile(home, ".aws/credentials", "[default]\naws_access_key_id = AKIAZZ9AWSACCESS0123\naws_secret_access_key = ZZ9awssecretkey0123456789abcdef\n");
  await writeFixtureFile(home, ".docker/config.json", json({ auths: { "ghcr.io": { auth: "ZZ9dockerauth0123456789==" } }, credsStore: "osxkeychain" }));
  await writeFixtureFile(home, ".lark-cli/config.json", json({ apps: [{ appId: "cli_a", appSecret: { source: "keychain", id: "ZZ9keychainid01" } }, { appId: "cli_b", appSecret: "SECRETVALUElarkinline0123" }] }));
  const skill = path.join(home, ".claude", "skills", "with-env");
  await writeFixtureFile(skill, "SKILL.md", "---\nname: with-env\n---\n");
  await writeFixtureFile(skill, ".env", "SERVICE_API_KEY=SECRETVALUEskillenv012345\nLOG_LEVEL=debug\n");
  await writeFixtureFile(skill, ".env.example", "SERVICE_API_KEY=placeholder-not-listed\n");
  return { skillDirectories: [{ directory: skill, name: "with-env", agentIds: ["claude"] }] };
}

async function setup(context) {
  const home = await mkdtemp(path.join(tmpdir(), "secrets-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const { skillDirectories } = await createSecretsHome(home);
  const stateDirectory = path.join(home, ".agent-skill-manager");
  const build = (now = Date.parse("2026-10-24T00:00:00Z")) => buildSecretsInventory({ homeDirectory: home, homes: [home], stateDirectory, skillDirectories, now });
  return { home, stateDirectory, build };
}

test("the inventory lists every source by key name and storage, never a value", { timeout: 30_000, skip: !POSIX }, async (context) => {
  const { home, stateDirectory, build } = await setup(context);
  const inventory = await build();
  const text = JSON.stringify(inventory);
  assert.doesNotMatch(text, MARKERS, "no planted value in the output");
  assert.equal(text.includes(home), false, "paths are ~/ only");
  assert.deepEqual(Object.keys(inventory.summary.byStorage), STORAGE_TYPES);
  assert.equal(inventory.summary.total, inventory.items.length);
  assert.equal(inventory.summary.plaintext, inventory.items.filter((item) => item.storage === "plaintext").length);

  const find = (location, keyName) => inventory.items.find((item) => item.location.startsWith(location) && item.keyName === keyName);
  // Agent configuration, MCP servers, .env files, CLI stores.
  assert.equal(find("~/.claude/settings.json", "SECRET_SETTING").storage, "plaintext");
  assert.equal(find("~/.codex/config.toml", "REMOTE_TOKEN").storage, "env-ref");
  assert.ok(find("~/.codex/config.toml", "API_TOKEN"), "MCP env literal");
  assert.ok(find("~/.claude.json", "X-API-Key"), "MCP header literal");
  assert.equal(find("~/.gemini/.env", "GEMINI_API_KEY").service, "Google");
  assert.equal(find("~/.gemini/.env", "DEBUG"), undefined, "settings are not secrets");
  assert.equal(find("~/.gemini/.env", "GEMINI_TIMEOUT_MS"), undefined);
  assert.ok(find("~/.workbuddy/.env", "WORKBUDDY_TOKEN"));
  assert.ok(find("~/.hermes/.env", "OPENAI_API_KEY"));
  assert.ok(inventory.items.some((item) => item.location.startsWith("~/.hermes/config.yaml")), "Hermes config outside mcp_servers");
  assert.ok(inventory.items.some((item) => item.agents.includes("openclaw") && item.location === "~/.openclaw/auth-profiles.json · profiles.default.apiKey"), "legacy flat auth-profiles.json");
  assert.equal(inventory.items.find((item) => item.location.endsWith("agents/main/agent/auth-profiles.json · profiles.anthropic:me.access")).storage, "oauth");
  const sqlite = inventory.items.find((item) => item.location === "~/.openclaw/agents/main/agent/openclaw-agent.sqlite");
  assert.deepEqual([sqlite.storage, sqlite.keyName, sqlite.fingerprint], ["credential-file", "模型登录凭据", undefined]);
  assert.ok(inventory.items.some((item) => item.location.startsWith("~/.openclaw/credentials/oauth.json") && item.storage === "oauth"), "legacy OAuth import file");
  assert.ok(inventory.items.some((item) => item.agents.includes("office-raccoon") && item.keyName === "api_key"));
  assert.deepEqual([find("~/.config/gh/hosts.yml", "oauth_token").storage, find("~/.config/gh/hosts.yml", "登录令牌").storage], ["oauth", "keychain"]);
  assert.match(find("~/.config/gh/hosts.yml", "登录令牌").note, /钥匙串/u);
  assert.equal(find("~/.npmrc", "_authToken").storage, "credential-file");
  assert.equal(find("~/.netrc", "password（api.example.test）").storage, "credential-file");
  assert.equal(find("~/.aws/credentials", "aws_secret_access_key").service, "AWS");
  assert.equal(find("~/.docker/config.json", "auth").storage, "credential-file");
  assert.equal(find("~/.docker/config.json", "登录凭据").storage, "keychain");
  const lark = inventory.items.filter((item) => item.location.startsWith("~/.lark-cli/config.json"));
  assert.deepEqual(lark.map((item) => item.storage).sort(), ["keychain", "plaintext"]);
  // Skill folders: key names only, no fingerprint; .env.example is not a secret file.
  const skillItem = find("~/.claude/skills/with-env/.env", "SERVICE_API_KEY");
  assert.deepEqual([skillItem.usedBy, skillItem.fingerprint], [[{ kind: "skill", name: "with-env" }], undefined]);
  assert.equal(inventory.items.some((item) => item.location.includes(".env.example")), false);
  assert.equal(find("~/.claude/skills/with-env/.env", "LOG_LEVEL"), undefined);

  // Fingerprints: 8 hex digits for long literals, never for references or keychain notes.
  for (const item of inventory.items) {
    if (item.fingerprint) assert.match(item.fingerprint, /^[a-f0-9]{8}$/u);
    if (item.storage === "env-ref" || item.storage === "keychain") assert.equal(item.fingerprint, undefined, item.keyName);
    assert.equal(typeof item.firstSeenAt, "string");
  }
  // Remedies explain what to do per storage type, without values.
  for (const item of inventory.items) {
    const remedy = remedyForSecret(item, { homes: [home] });
    if (remedy) assert.doesNotMatch(JSON.stringify(remedy), MARKERS);
  }

  // Salt and snapshot: owner-only files that never contain values.
  const salt = await stat(path.join(stateDirectory, "secret-salt"));
  assert.equal(salt.mode & 0o777, 0o600);
  const snapshotFile = path.join(stateDirectory, "secret-snapshot.json");
  assert.equal((await stat(snapshotFile)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(snapshotFile, "utf8"), MARKERS);
  assert.deepEqual(inventory.changes, [], "the first inventory is the baseline");
});

test("changes: a rotated value, a new secret and a removed one are reported", { timeout: 30_000, skip: !POSIX }, async (context) => {
  const { home, build } = await setup(context);
  const first = await build(Date.parse("2026-10-24T00:00:00Z"));
  const before = first.items.find((item) => item.location.startsWith("~/.aws/credentials") && item.keyName === "aws_secret_access_key");
  await writeFixtureFile(home, ".aws/credentials", "[default]\naws_access_key_id = AKIAZZ9AWSACCESS0123\naws_secret_access_key = ZZ9awssecretROTATED456789abcdef\n");
  await writeFixtureFile(home, ".gemini/.env", "GEMINI_API_KEY=ZZ9geminidotenv0123456789\nSECOND_API_KEY=ZZ9secondkey0123456789ab\n");
  await rm(path.join(home, ".netrc"));
  const second = await build(Date.parse("2026-10-25T00:00:00Z"));
  const after = second.items.find((item) => item.id === before.id);
  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.deepEqual([after.firstSeenAt, after.changedAt], ["2026-10-24T00:00:00.000Z", "2026-10-25T00:00:00.000Z"]);
  const kinds = second.changes.map((change) => `${change.kind}:${change.keyName}`).sort();
  assert.deepEqual(kinds, ["added:SECOND_API_KEY", "changed:aws_secret_access_key", "removed:password（api.example.test）"]);
  assert.doesNotMatch(JSON.stringify(second), MARKERS);
  // An unchanged run reports nothing new but keeps the history.
  const third = await build(Date.parse("2026-10-26T00:00:00Z"));
  assert.deepEqual(third.changes.map((change) => change.kind).sort(), ["added", "changed", "removed"]);
});

test("guessService: key names and hosts first, then the fallback", () => {
  assert.equal(guessService(["OPENAI_API_KEY"]), "OpenAI");
  assert.equal(guessService(["token", "https://open.feishu.cn"], "x"), "飞书");
  assert.equal(guessService(["token"], "sellersprite-mcp"), "sellersprite-mcp");
});
