import path from "node:path";
import { writeFixtureFile } from "./smartorder.mjs";

/**
 * Fixtures with distinctive planted secrets. Every secret contains "PLANT" (upper case)
 * so a test can assert that no response body contains it. Non-secret values that must
 * stay visible are listed in VISIBLE_VALUES.
 */

export const PLANT_PATTERN = /PLANT/u;
export const VISIBLE_VALUES = [
  "/usr/local/bin/planted-server",
  "/srv/planted",
  "/var/lib/planted",
  "remote.example.test",
  "REMOTE_TOKEN",
  "${SAFE_REF}",
  "${SAFE_HEADER_ENV}",
  "Bearer ${SAFE_TOKEN}",
  "localhost",
  "tool_timeout_sec = 45",
  "--port",
];

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

export const CODEX_PLANTED_TOML = `
model = "gpt-test"
model_reasoning_effort = "high"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
mcp_oauth_credentials_store = "file"

[features]
memories = true
js_repl = false

[shell_environment_policy.set]
PLANT_SHELL_NAME = "PLANT-SHELLVALUE-0"

[projects."/tmp/trusted-project"]
trust_level = "trusted"

[marketplaces.personal]
source_type = "local"
source = "/PLANT-MARKETSOURCE"

[plugins."demo@personal"]
enabled = true

[mcp_servers.planted]
command = "/usr/local/bin/planted-server"
args = [
  "--port", "8080",
  "API_KEY=PLANT-ARGKV-1",
  "--header", "X-Token: PLANT-HEADERARG-2",
  "Authorization: Bearer PLANTBEARERARG3",
  "--token", "PLANT-FLAGNEXT-4",
  "--secret=PLANT-FLAGEQ-5",
  "https://user:PLANT-USERINFO-6@api.example.test/v1?key=PLANT-QUERY-7",
  "https://hooks.example.test/services/PLANTPATHTOKEN8abcdefghijklmno/x",
  "-e", "ANY=PLANT-ENVFLAG-9",
]
cwd = "/srv/planted"
tool_timeout_sec = 45

[mcp_servers.planted.env]
API_TOKEN = "PLANT-ENV-10"
DATA_DIR = "/var/lib/planted"
NESTED_REF = "\${SAFE_REF}"
RAW = "ghp_PLANT0123456789abcdefABCDEF"

[mcp_servers.remote-planted]
url = "https://user2:PLANT-URLPASS-11@remote.example.test/mcp/PLANTPATHSEG12abcdefghijklmn?token=PLANT-URLQUERY-13"
bearer_token = "PLANT-BEARERTOKEN-14"
bearer_token_env_var = "REMOTE_TOKEN"
startup_timeout_sec = 30

[mcp_servers.remote-planted.http_headers]
Authorization = "Bearer PLANT-HEADER-15"
X-Custom = "PLANT-HEADER-16"
X-Env = "\${SAFE_HEADER_ENV}"

[mcp_servers.remote-planted.oauth]
client_id = "PLANT-OAUTHID-17"
client_secret = "PLANT-OAUTHSECRET-18"

[mcp_servers.remote-planted.nested.deeper]
api_key = "PLANT-NESTED-19"
`;

export async function createPlantedConfigFixture(home) {
  await writeFixtureFile(home, ".codex/config.toml", CODEX_PLANTED_TOML);
  await writeFixtureFile(home, ".codex/hooks.json", json({ hooks: { Stop: [], SessionStart: [] } }));
  await writeFixtureFile(home, ".claude.json", json({
    oauthAccount: { emailAddress: "PLANT-EMAIL@example.test" },
    mcpServers: {
      claudeplanted: {
        type: "http",
        url: "https://api.claude.example.test/mcp?api_key=PLANT-CQ-20",
        headers: { "X-API-Key": "PLANT-CH-21", Accept: "application/json", Ref: "Bearer ${SAFE_TOKEN}" },
      },
      planted: { command: "node", args: ["server.js", "--api-key", "PLANT-CLAUDEARG-22"] },
    },
    projects: {
      [path.join(home, "Projects", "demo")]: {
        mcpServers: {
          projplanted: {
            command: "node",
            args: ["server.js"],
            env: { DB_PASSWORD: "PLANT-CENV-23", DB_HOST: "localhost" },
          },
        },
      },
    },
  }));
  await writeFixtureFile(home, ".claude/settings.json", json({
    permissions: {
      allow: ["Bash(npm test)", "Bash(curl -H 'Authorization: Bearer PLANTRULE24abcdef' x)"],
      deny: ["Read(./.env)"],
      defaultMode: "acceptEdits",
    },
    hooks: { Stop: [], PreToolUse: [] },
    enabledPlugins: { "warp@claude-code-warp": true },
    statusLine: { type: "command", command: `${home}/bin/statusline --jwt eyJPLANTabcdef.eyJPLANTabcdef.PLANTsignature` },
    theme: "dark",
    env: { SECRET_SETTING: "PLANT-SETTINGSENV-25" },
    skipDangerousModePermissionPrompt: true,
  }));
  await writeFixtureFile(home, ".cursor/mcp.json", json({
    mcpServers: { cursorplanted: { command: "npx", args: ["-y", "pkg", "--api-key", "PLANT-CURSOR-26"] } },
  }));
  await writeFixtureFile(home, ".gemini/settings.json", json({
    mcpServers: {
      pencil: { command: "pencil", env: { PENCIL_TOKEN: "ghp_PLANTGHP0123456789abcdef27" } },
      geminiplanted: { httpUrl: "https://gem.example.test/mcp", headers: { Authorization: "{env:GEM_TOKEN}", Cookie: "PLANT-COOKIE-28" } },
    },
    hooks: { BeforeTool: [] },
    ui: { theme: "GitHub" },
  }));
  await writeFixtureFile(home, ".workbuddy/settings.json", json({
    sandbox: { extraAllowWrite: ["/tmp/a", "/tmp/b"], orderedRules: { one: {}, two: {} }, networkDenyAllMigrated: true },
    enabledPlugins: { "demo@workbuddy-builtin": true, "off@workbuddy-builtin": false },
    hooks: { Stop: [] },
    claw: { users: { secret: "PLANT-CLAW-29" } },
  }));
}

/** A Claude Code plugin and a WorkBuddy plugin whose .mcp.json files carry planted secrets. */
export async function createPlantedPluginFixture(home) {
  const claudeInstall = path.join(home, ".claude", "plugins", "cache", "market", "planted-plugin", "1.0.0");
  await writeFixtureFile(claudeInstall, ".claude-plugin/plugin.json", json({
    name: "planted-plugin",
    version: "1.0.0",
    description: "Uses Bearer PLANTMANIFEST30abcdef in docs",
    author: { name: "Fixture" },
  }));
  await writeFixtureFile(claudeInstall, ".mcp.json", json({
    mcpServers: {
      pluginserver: {
        type: "http",
        url: "https://plugin.example.test/mcp?token=PLANT-PLUGINQUERY-31",
        headers: { Authorization: "Bearer PLANT-PLUGINHEADER-32" },
        env: { TOKEN: "PLANT-PLUGINENV-33", MODE: "fast" },
      },
    },
  }));
  await writeFixtureFile(claudeInstall, "skills/plugin-skill/SKILL.md", "---\nname: plugin-skill\n---\n");
  await writeFixtureFile(home, ".claude/plugins/installed_plugins.json", json({
    version: 2,
    plugins: { "planted-plugin@market": [{ scope: "user", installPath: claudeInstall, version: "1.0.0" }] },
  }));
  const workbuddyInstall = path.join(home, ".workbuddy", "plugins", "cache", "workbuddy-builtin", "demo", "2.0.0");
  await writeFixtureFile(workbuddyInstall, ".codebuddy-plugin/plugin.json", json({
    name: "demo",
    version: "2.0.0",
    displayName: { en: "Demo", zh: "演示插件" },
    description: "WorkBuddy demo plugin",
    agents: ["./agents/helper.md"],
  }));
  await writeFixtureFile(workbuddyInstall, "agents/helper.md", "# helper\n");
  await writeFixtureFile(workbuddyInstall, "commands/run.md", "# run\n");
  await writeFixtureFile(workbuddyInstall, ".mcp.json", json({
    mcpServers: { wbserver: { command: "wb", env: { API_KEY: "PLANT-WBENV-34" } } },
  }));
  const outside = path.join(home, "outside-workbuddy-plugin");
  await writeFixtureFile(outside, ".codebuddy-plugin/plugin.json", json({ name: "PLANT-OUTSIDE-35" }));
  await writeFixtureFile(home, ".workbuddy/plugins/installed_plugins.json", json({
    version: 2,
    plugins: {
      "demo@workbuddy-builtin": [{ scope: "user", installPath: workbuddyInstall, version: "2.0.0" }],
      "escape@workbuddy-builtin": [{ scope: "user", installPath: outside, version: "1" }],
    },
  }));
  return { claudeInstall, workbuddyInstall };
}
