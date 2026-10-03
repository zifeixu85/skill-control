import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { writeFixtureFile } from "./smartorder.mjs";

/**
 * Hermes Agent, OpenClaw, QClaw and LumiClaw layouts with planted secrets. Every secret
 * contains "ZZ9" so the leak probe (tests/leak-probe.test.mjs) covers these products.
 */

const skill = (name, extra = "") => `---\nname: ${name}\ndescription: ${name} fixture\n${extra}---\n# ${name}\n`;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const POSIX = process.platform !== "win32";

export async function createSharedSkill(home) {
  const shared = path.join(home, "shared", "skills");
  await writeFixtureFile(shared, "linked-skill/SKILL.md", skill("linked-skill"));
  return shared;
}

export async function createHermesHome(home, { withDatabase = true } = {}) {
  const hermes = path.join(home, ".hermes");
  const skills = path.join(hermes, "skills");
  await writeFixtureFile(hermes, "config.yaml", `
model:
  provider: openai-codex
  default: gpt-5.5
  base_url: https://api.example.test/v1?key=ZZ9hermesurlkey01
toolsets:
  - hermes-cli
delegation:
  orchestrator_enabled: true
  provider: openrouter
  model: claude-sonnet
  api_key: ZZ9hermesdelegationkey02
  base_url: https://u:ZZ9hermesdelegationurl03@proxy.example.test/v1
  max_concurrent_children: 3
skills:
  disabled: [disabled-skill]
  platform_disabled:
    telegram: [plat-skill]
  external_dirs:
    - ~/hermes-external
    - \${HERMES_MISSING_VAR}/nowhere
  write_approval: true
memory:
  memory_enabled: true
  provider: holographic
  write_approval: false
curator:
  enabled: true
  stale_after_days: 30
  archive_after_days: 90
  prune_builtins: true
approvals:
  mode: manual
plugins:
  enabled: [demo-plugin]
  disabled: []
platforms:
  telegram:
    token: ZZ9hermestelegram04
mcp_servers:
  hermcp:
    command: npx
    args: ["-y", "pkg", "--token", "ZZ9hermesmcparg05"]
    env:
      API_KEY: ZZ9hermesmcpenv06
      LOG_LEVEL: debug
    url: https://u:ZZ9hermesmcpurl07@mcp.example.test/x
    headers:
      Authorization: Bearer ZZ9hermesmcphdr08
    auth:
      client_secret: ZZ9hermesmcpauth09
    enabled: true
    timeout: 120
    tools:
      include: [search, fetch]
secrets:
  bitwarden:
    token: ZZ9hermesbitwarden10
`);
  await writeFixtureFile(skills, "productivity/nested-skill/SKILL.md", skill("nested-skill"));
  await writeFixtureFile(skills, "flat-skill/SKILL.md", skill("flat-skill"));
  await writeFixtureFile(skills, "bundled-skill/SKILL.md", skill("bundled-skill"));
  await writeFixtureFile(skills, "hub-skill/SKILL.md", skill("hub-skill"));
  await writeFixtureFile(skills, "disabled-skill/SKILL.md", skill("disabled-skill"));
  await writeFixtureFile(skills, "plat-skill/SKILL.md", skill("plat-skill"));
  await writeFixtureFile(skills, "with-support/SKILL.md", skill("with-support"));
  await writeFixtureFile(skills, "with-support/references/old-package/SKILL.md", skill("support-not-a-skill"));
  await writeFixtureFile(skills, "node_modules/dep/SKILL.md", skill("dependency-not-a-skill"));
  await writeFixtureFile(skills, ".archive/old-skill/SKILL.md", skill("old-skill"));
  await writeFixtureFile(skills, "_org/.active_org", "acme\n");
  await writeFixtureFile(skills, "_org/acme/org-skill/SKILL.md", skill("org-skill"));
  await writeFixtureFile(skills, "_org/other/stale-org-skill/SKILL.md", skill("stale-org-skill"));
  await writeFixtureFile(skills, ".bundled_manifest", "bundled-skill:0123abcd\nold-skill:4567ef01\n");
  await writeFixtureFile(skills, ".hub/lock.json", json({ version: 1, installed: { "hub-skill": { source: "hub", install_path: "hub-skill" } } }));
  await writeFixtureFile(skills, ".usage.json", json({
    "flat-skill": { use_count: 7, view_count: 3, patch_count: 1, last_used_at: "2026-09-30T10:00:00+00:00", state: "active", pinned: true, created_by: "user" },
    "old-skill": { use_count: 0, state: "archived", archived_at: "2026-08-01T00:00:00+00:00" },
  }));
  if (POSIX) {
    const shared = await createSharedSkill(home);
    await symlink(path.join(shared, "linked-skill"), path.join(skills, "linked-skill"));
  }
  await writeFixtureFile(home, "hermes-external/ext-skill/SKILL.md", skill("ext-skill"));
  await writeFixtureFile(home, "hermes-external/flat-skill/SKILL.md", skill("flat-skill", "version: 9.9.9\n"));
  await writeFixtureFile(hermes, "profiles/research/skills/prof-skill/SKILL.md", skill("prof-skill"));
  await writeFixtureFile(hermes, "profiles/research/config.yaml", "model:\n  provider: anthropic\n  default: claude-research\n");
  await writeFixtureFile(hermes, "profiles/research/SOUL.md", "# Research\n\nPassword: ZZ9hermesprofilesoul11\n");
  await writeFixtureFile(hermes, "SOUL.md", "# Hermes\n\nThe api key is ZZ9hermessoul12 for staging.\n");
  await writeFixtureFile(hermes, "plugins/demo-plugin/plugin.yaml", "name: demo-plugin\nversion: 1.2.0\ndescription: Demo plugin\nconfig:\n  token: ZZ9hermesplugin13\n");
  await writeFixtureFile(hermes, "cron/jobs.json", json({ jobs: [{ id: "j1", name: "Daily digest", schedule_display: "every day 9:00", enabled: true, prompt: "secret prompt ZZ9hermescron14" }] }));
  await writeFixtureFile(hermes, "gateway_state.json", json({ pid: 1, gateway_state: "running", argv: ["--token", "ZZ9hermesgateway15"] }));
  await writeFixtureFile(hermes, "gateway.pid", "1");
  await writeFixtureFile(hermes, "memories/MEMORY.md", "remember ZZ9hermesmemory16\n");
  await writeFixtureFile(hermes, ".env", "OPENAI_API_KEY=ZZ9hermesdotenv17\n");
  await writeFixtureFile(hermes, "auth.json", json({ token: "ZZ9hermesauthjson18" }));
  await writeFixtureFile(hermes, "channel_directory.json", json({ chats: { "ZZ9hermeschat19": "x" } }));
  await writeFixtureFile(hermes, "active_profile", "default\n");
  await writeFixtureFile(hermes, "hermes-agent/pyproject.toml", '[project]\nname = "hermes-agent"\nversion = "0.20.2"\n');
  if (withDatabase) {
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(path.join(hermes, "state.db"));
    database.exec(
      "CREATE TABLE sessions (id TEXT, title TEXT, started_at REAL, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, estimated_cost_usd REAL); CREATE TABLE messages (id TEXT, content TEXT);",
    );
    const now = Date.now() / 1000;
    const insert = database.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    insert.run("s1", "ZZ9hermestitle20", now - 3_600, 1_000, 500, 100, 0, 0.12);
    insert.run("s2", "ZZ9hermestitle21", now - 7_200, 2_000, 1_000, 0, 0, 0.3);
    insert.run("s3", "ZZ9hermestitle22", now - 60 * 86_400, 9_000, 9_000, 0, 0, 1);
    database.prepare("INSERT INTO messages VALUES (?, ?)").run("m1", "ZZ9hermesmessage23");
    database.close();
  }
  return { hermes, skills };
}

const OPENCLAW_CONFIG = (home, agents) => `// OpenClaw config (JSON5) with comments and trailing commas
{
  meta: { lastTouchedVersion: "2026.4.21", lastTouchedAt: "2026-06-09T17:33:10.731Z", },
  skills: {
    load: { extraDirs: ["~/oc-extra",], },
    entries: {
      "off-skill": { enabled: false, apiKey: "ZZ9ocskillkey01", env: { TOKEN: "ZZ9ocskillenv02" } },
    },
  },
  ${agents},
  models: { providers: { acme: { apiKey: "ZZ9ocproviderkey03", baseUrl: "https://api.acme.test/v1" } } },
  mcp: {
    servers: {
      ocmcp: {
        command: "npx",
        args: ["-y", "pkg", "--api-key=ZZ9ocmcparg04"],
        env: { SECRET_TOKEN: "ZZ9ocmcpenv05", MODE: "production" },
        headers: { Authorization: "Bearer ZZ9ocmcphdr06" },
      },
    },
  },
  plugins: { allow: ["vibe-island"], entries: { "vibe-island": { enabled: true, config: { token: "ZZ9ocplugincfg07" } } } },
  channels: { telegram: { enabled: true, token: "ZZ9octelegram08" }, discord: { enabled: false, botToken: "ZZ9ocdiscord09" } },
  gateway: { mode: "local", bind: "loopback", port: 18789, auth: { mode: "token", token: "ZZ9ocgateway10" } },
}
`;

export async function createOpenClawHome(home, { agentsVariant = "list" } = {}) {
  const state = path.join(home, ".openclaw");
  const agents =
    agentsVariant === "entries"
      ? 'agents: { entries: { main: { default: true, model: "anthropic/claude-sonnet" }, writer: { workspace: "~/oc-writer" } } }'
      : agentsVariant === "none"
        ? "agents: {}"
        : 'agents: { defaults: { model: { primary: "anthropic/claude-sonnet" } }, list: [{ id: "main", default: true }, { id: "writer", workspace: "~/oc-writer", skills: ["ws-skill"] }] }';
  await writeFixtureFile(state, "openclaw.json", OPENCLAW_CONFIG(home, agents));
  await writeFixtureFile(state, "skills/managed-skill/SKILL.md", skill("managed-skill"));
  await writeFixtureFile(state, "skills/off-skill/SKILL.md", skill("off-skill"));
  await writeFixtureFile(state, "skills/clawhub-skill/SKILL.md", skill("clawhub-skill"));
  await writeFixtureFile(state, "skills/clawhub-skill/.clawhub/origin.json", json({ registry: "https://clawhub.example.test", token: "ZZ9occlawhub11" }));
  await writeFixtureFile(state, "skills/needs-bins/SKILL.md", skill(
    "needs-bins",
    'metadata:\n  {\n    "openclaw":\n      {\n        "emoji": "🔐",\n        "requires": { "bins": ["op"], "env": ["OP_TOKEN"] },\n        "install": [{ "kind": "brew", "formula": "op" }],\n      },\n  }\n',
  ));
  await writeFixtureFile(home, "oc-extra/extra-skill/SKILL.md", skill("extra-skill"));
  await writeFixtureFile(home, "oc-extra/managed-skill/SKILL.md", skill("managed-skill", "version: 0.0.1\n"));
  await writeFixtureFile(state, "workspace/skills/ws-skill/SKILL.md", skill("ws-skill"));
  await writeFixtureFile(state, "workspace/IDENTITY.md", "# IDENTITY.md\n\n- Name: Claw\n- Emoji: 🦞\n- Vibe: helpful\n");
  await writeFixtureFile(state, "workspace/SOUL.md", "# Soul\n\nNever share the token: ZZ9ocsoul12\n");
  await writeFixtureFile(home, "oc-writer/AGENTS.md", "# Writer\n\nAPI_KEY=ZZ9ocwriter13\n");
  if (POSIX) {
    // OpenClaw skips links whose real path leaves the root; the copy is still shown.
    const elsewhere = path.join(home, "elsewhere");
    await writeFixtureFile(elsewhere, "escaped-skill/SKILL.md", skill("escaped-skill"));
    await symlink(path.join(elsewhere, "escaped-skill"), path.join(state, "skills", "escaped-skill"));
  }
  await writeFixtureFile(state, "agents/main/sessions/sessions.json", json({
    "agent:main:1": { sessionId: "sess-1", updatedAt: Date.now() - 3_600_000, inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500, estimatedCostUsd: 0.2, model: "claude", lastMessage: "ZZ9ocsession14" },
    "agent:main:2": { sessionId: "sess-2", updatedAt: Date.now() - 90 * 86_400_000, totalTokens: 99_999 },
  }));
  await writeFixtureFile(state, "agents/main/sessions/sess-1.jsonl", `${JSON.stringify({ type: "tool_call", arguments: { path: "/x/skills/managed-skill/SKILL.md" }, secret: "ZZ9ocjsonl15" })}\n`);
  await writeFixtureFile(state, "credentials/oauth.json", json({ token: "ZZ9occredentials16" }));
  await writeFixtureFile(state, "auth-profiles.json", json({ default: { apiKey: "ZZ9ocauthprofiles17" } }));
  await writeFixtureFile(state, "identity/device-auth.json", json({ privateKey: "ZZ9ocdeviceauth18" }));
  await writeFixtureFile(state, "AGENTS.md", "# Agents\n<!-- lumiclaw:begin -->\nmanaged\n<!-- lumiclaw:end -->\n");
  await writeFixtureFile(state, "LUMICLAW.md", "# LumiClaw\n");
  await writeFixtureFile(state, "extensions/vibe-island/openclaw.plugin.json", json({ id: "vibe-island", name: "Vibe Island", description: "Island", configSchema: { token: "ZZ9ocpluginschema19" } }));
  await writeFixtureFile(state, "extensions/vibe-island/package.json", json({ name: "vibe-island", version: "1.0.0" }));
  return { state };
}

export async function createQClawHome(home) {
  const state = path.join(home, ".qclaw");
  const runtime = path.join(home, "Library", "Application Support", "QClaw", "openclaw", "node_modules", "openclaw");
  const configSkills = path.join(home, "Library", "Application Support", "QClaw", "openclaw", "config", "skills");
  await writeFixtureFile(state, "qclaw.json", json({
    authGatewayBaseUrl: "https://gateway.example.test/ZZ9qclawgateway01",
    sharedParams: { guid: "ZZ9qclawguid02", sessionId: "ZZ9qclawsession03", appVersion: "0.2.25" },
    cli: { nodeBinary: "/Applications/QClaw.app/node", openclawMjs: path.join(runtime, "openclaw.mjs"), pid: 1 },
    stateDir: state,
    configPath: path.join(state, "openclaw.json"),
    port: 63947,
  }));
  await writeFixtureFile(runtime, "package.json", json({ name: "openclaw", version: "2026.4.21" }));
  await writeFixtureFile(runtime, "skills/bundled-a/SKILL.md", skill("bundled-a"));
  await writeFixtureFile(runtime, "skills/shared-name/SKILL.md", skill("shared-name"));
  await writeFixtureFile(runtime, "extensions/browser/openclaw.plugin.json", json({ id: "browser", name: "Browser" }));
  await writeFixtureFile(configSkills, "shared-name/SKILL.md", skill("shared-name", "version: 2.0.0\n"));
  await writeFixtureFile(configSkills, "config-only/SKILL.md", skill("config-only"));
  await writeFixtureFile(state, "openclaw.json", `{
  // QClaw passes its own folders as extra skill dirs
  meta: { lastTouchedVersion: "2026.4.21" },
  skills: {
    load: { extraDirs: ["~/Library/Application Support/QClaw/openclaw/config/skills", "~/.qclaw/skills", "~/.qclaw/skillhub-skills"] },
    entries: { "remote-a": { enabled: false } },
  },
  agents: { defaults: { workspace: "~/.qclaw/workspace", model: { primary: "qclaw/modelroute" } }, list: [{ id: "main", default: true, name: "Q" }] },
  models: { providers: { qclaw: { apiKey: "ZZ9qclawproviderkey04" } } },
  channels: { "wechat-access": { enabled: true, token: "ZZ9qclawchannel05", guid: "ZZ9qclawchannelguid06" } },
  gateway: { mode: "local", bind: "loopback", port: 28789, auth: { mode: "token", token: "ZZ9qclawgatewaytoken07" } },
}
`);
  await writeFixtureFile(state, "skills/remote-a/SKILL.md", skill("remote-a"));
  await writeFixtureFile(state, "skills/.remote-skills-meta.json", json({
    skills: { "remote-a": { type: "official", version: "1.4.0", sha256: "ZZ9qclawsha08", install_mode: "auto", effect_scope: "global" } },
    last_sync: "2026-10-01T00:00:00Z",
  }));
  await mkdir(path.join(state, "skillhub-skills"), { recursive: true });
  await writeFixtureFile(state, "workspace/IDENTITY.md", "- Name: QClaw 助手\n- Vibe: 中文助手\n");
  await writeFixtureFile(state, "agents/main/agent/models.json", json({ apiKey: "ZZ9qclawmodels09" }));
  return { state, runtime };
}

export async function createLumiClawHome(home) {
  await writeFixtureFile(home, ".lumiclaw/config.json", json({ token: "ZZ9lumiclawtoken01" }));
  await mkdir(path.join(home, ".lumiclaw", "agents", "a1"), { recursive: true });
  await mkdir(path.join(home, ".lumiclaw", "agents", "a2"), { recursive: true });
}
