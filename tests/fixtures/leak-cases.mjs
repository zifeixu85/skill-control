import path from "node:path";
import { writeFixtureFile } from "./smartorder.mjs";

/**
 * Hostile configuration shapes (ported from the security review's probe harness).
 * Every planted secret contains MARKER; a response that contains MARKER is a leak.
 * Each table entry is one shape, so a regression points at the exact case.
 */

export const MARKER = "ZZ9";
export const MARKER_PATTERN = /ZZ9[A-Za-z0-9]{1,24}/gu;

/** Codex `[mcp_servers.<name>]` sections. */
export const CODEX_MCP_CASES = [
  ["t01_pgpos", `command = "npx"\nargs = ["-y", "@modelcontextprotocol/server-postgres", "postgresql://appuser:ZZ9pgpos01@db.internal:5432/app"]`],
  ["t02_envflag", `command = "docker"\nargs = ["run", "-i", "--rm", "--env=DB_PASS=ZZ9envEq02", "-eFOO=ZZ9dashE02b", "-e", "OK=ZZ9eflag02c", "img"]`],
  ["t03_envtable", `command = "node"\nenv = { PGPASSWORD = "ZZ9pgpassword03a", DATABASE_URL = "postgres://u:ZZ9dburl03b@h/db", PASSPHRASE = "ZZ9passphr03c", SERVICE_ACCOUNT = "ZZ9svcacct03d", CONN = "Server=x;Password=ZZ9conn03e", LOG_LEVEL = "debug" }`],
  ["t04_cmdline", `command = "npx -y srv --token ZZ9cmdline04a --api-key=ZZ9cmdline04b"`],
  ["t05_mongo", `url = "mongodb+srv://u:ZZ9mongo05@cluster0.mongodb.net/db"`],
  ["t06_leadspace", `url = " https://u:ZZ9lead06@host.example.test/x"`],
  ["t07_passflags", `command = "srv"\nargs = ["-p", "ZZ9mysqlp07a", "--pass", "ZZ9passflag07b", "--passphrase", "ZZ9passphrase07c", "-pZZ9glued07d", "-u", "admin:ZZ9curlu07e"]`],
  ["t08_split", `command = "srv"\nargs = ["--api-key", "ZZ9apikey08a", "--header", "X-Custom: ZZ9hdr08b", "-H", "Authorization: token ZZ9tokscheme08c", "token:ZZ9nospace08d", "--header=X-Api-Token: ZZ9hdreq08e", "Authorization: Basic Wlo5YmFzaWM4ZjpwdzEyMzQ1Ng=="]`],
  ["t09_shortpath", `url = "https://mcp.example.test/s/ZZ9short09abcde/tools"`],
  ["t10_headers", `url = "https://mcp.example.test/mcp"\nhttpHeaders = { "X-Tenant" = "ZZ9camelhdr10a" }\nrequest_headers = { "X-Foo" = "ZZ9reqhdr10b" }\nextra_headers = ["X-Foo: ZZ9arrhdr10c"]\n[mcp_servers.t10_headers.http_headers]\n"X-Tenant" = "ZZ9snakehdr10d"`],
  ["t11_multiline", `command = '''\nsrv --token ZZ9multiline11a\n'''\n[mcp_servers.t11_multiline.env]\nFOO = """\nline1\nZZ9multienv11b\n"""`],
  ["t13_names", `command = "srv"\nauth_token = "ZZ9authtok13a"\npass = "ZZ9pass13b"\npw = "ZZ9pw13c"\ndsn = "ZZ9dsn13d"\nwebhook = "ZZ9webhook13e"\nsecret_ref = "ZZ9secretref13f"\nprivate_blob = "ZZ9blob13g"`],
  ["t15_literalenvvar", `url = "https://mcp.example.test/mcp"\nbearer_token_env_var = "ZZ9literalNameField15"\nenv_vars = ["ZZ9literalList15b"]`],
  ["t16_oauth", `url = "https://mcp.example.test/mcp"\n[mcp_servers.t16_oauth.oauth]\nfoo = "ZZ9oauth16a"\n[mcp_servers.t16_oauth.authorization]\nfoo = "ZZ9authz16b"\n[mcp_servers.t16_oauth.credentials_store]\nfoo = "ZZ9credstore16c"`],
  ["t17_envarray", `command = "srv"\nenv = ["FOO=ZZ9envarr17"]`],
  ["t18_known", `command = "srv"\nargs = ["AKIAZZ9Q2WERTYUI1234", "xoxb-1234567890-ZZ9slack18b", "sk_live_ZZ9stripe18cabcdef"]\n[mcp_servers.t18_known.env]\nKEY_PEM = "-----BEGIN PRIVATE KEY-----\\nMIIEvQZZ9pem18d\\n-----END PRIVATE KEY-----"`],
  ["t19_pathcreds", `command = "srv"\nargs = ["--config", "/Users/someone/ZZ9notsecret19a/cfg.json", "ssh://git:ZZ9sshpw19b@git.example.test/repo.git", "git+https://x-access-token:ZZ9gitplus19c@github.com/o/r.git", "https://example.test/hook/ZZ9tok19dabcdefghijklmnop"]`],
  ["t20_url_bad_chars", `url = "https://host.example.test/mcp;jsessionid=ZZ9jsess20a?x=1"`],
];

/** Claude Code `~/.claude.json` user-scope MCP servers. */
export const CLAUDE_MCP_CASES = [
  ["c01_headers", { type: "http", url: "https://c.example.test/mcp", headers: { "X-Whatever": "ZZ9chdr01a", Authorization: "Bearer ZZ9cauth01b" } }],
  ["c02_args", { command: "node", args: ["x.js", "--database-url", "postgres://u:ZZ9cdburl02a@h/db", "--secret-name=ZZ9csn02b", "Cookie: sid=ZZ9ccookie02c"] }],
  ["c03_nested", { command: "node", servers: [{ env: { A: "ZZ9nestedarr03a" } }], settings: { custom: { depth: { x: "ZZ9deep03b" } } } }],
  ["c04_command", { command: "/bin/sh", args: ["-c", "TOKEN=ZZ9shc04a node srv.js"] }],
  ["c05_env", { command: "srv", env: { GITHUB_PAT: "ZZ9ghpat05a", NOTION_KEY: "ZZ9notion05b", SLACK_BOT: "ZZ9slackbot05c", WEBHOOK_URL: "https://hooks.slack.com/services/T0/B0/ZZ9whk05d", S3_SECRET: "ZZ9s3sec05e", MYSQL_PWD: "ZZ9mysqlpwd05f" } }],
];

export const OTHER_MCP_CASES = {
  claudeProject: ["c06_proj", { command: "x", env: { DB_URI: "mongodb://u:ZZ9cproj06@h/db" } }],
  cursor: ["u01_cursor", { command: "npx", args: ["-y", "pkg", "--connection-string", "ZZ9cursorcs01"], env: { CONNECTION_STRING: "Host=x;Password=ZZ9cursorenv01b" } }],
  gemini: ["g01_gem", { httpUrl: "https://g.example.test/mcp", headers: { "X-Org": "ZZ9gemhdr01a" }, oauth: { clientId: "ZZ9gemoauth01b", scopes: ["a"] }, env: { A: "ZZ9gemenv01c" } }],
};

export const ALL_MCP_NAMES = [
  ...CODEX_MCP_CASES.map(([name]) => name),
  ...CLAUDE_MCP_CASES.map(([name]) => name),
  ...Object.values(OTHER_MCP_CASES).map(([name]) => name),
];

/** Claude Code permission rules and status line commands. */
export const PERMISSION_CASES = {
  allow: [
    "Bash(GITHUB_TOKEN=ZZ9perm01a gh api /user)",
    "Bash(curl -u admin:ZZ9perm01b https://x.example.test)",
    "Bash(psql postgres://u:ZZ9perm01c@h/db -c 'select 1')",
    "Bash(curl -H 'X-Api-Key: ZZ9perm01d' https://x.example.test)",
    "Bash(export PASSWORD=ZZ9perm01e)",
    "Bash(npm test)",
    "WebFetch(domain:example.test)",
  ],
  deny: ["Read(./.env)"],
  ask: ["Bash(API_KEY=ZZ9perm01f ./run.sh:*)"],
};

/** Free text with credentials in prose, code blocks, JSON, YAML, PEM and command lines. */
export const SKILL_TEXT = `---
name: leaky
description: Use when deploying. Staging key is ZZ9fmdesc01 for testing
api_key: ZZ9fmapikey02
password: ZZ9fmpass03
metadata:
  secret: ZZ9fmnested04
---
# Leaky

Set these in .env:

\`\`\`
OPENAI_API_KEY=ZZ9skillenv05
DATABASE_PASSWORD=ZZ9skillenv06
export STRIPE_SECRET=ZZ9skillenv07
\`\`\`

{"password": "ZZ9skilljson08", "apiKey": "ZZ9skilljson09"}

password: ZZ9skillyaml10

-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAZZ9pemskill11
-----END RSA PRIVATE KEY-----

curl -H "X-Api-Key: ZZ9skillcurl12" https://x
curl -u admin:ZZ9skillcurl13 https://x
postgres://dbuser:ZZ9skillurl14@host/db
Basic concepts of bearer tokens
`;

export async function createLeakProbeHome(home) {
  await writeFixtureFile(
    home,
    ".codex/config.toml",
    `model = "gpt-test"\n${CODEX_MCP_CASES.map(([name, body]) => `\n[mcp_servers.${name}]\n${body}\n`).join("")}`,
  );
  await writeFixtureFile(home, ".claude.json", JSON.stringify({
    mcpServers: Object.fromEntries(CLAUDE_MCP_CASES),
    projects: {
      [path.join(home, "proj")]: { mcpServers: Object.fromEntries([OTHER_MCP_CASES.claudeProject]) },
      "/Users/other/elsewhere/proj": { mcpServers: { c07_other: { command: "x" } } },
    },
  }));
  await writeFixtureFile(home, ".cursor/mcp.json", JSON.stringify({ mcpServers: Object.fromEntries([OTHER_MCP_CASES.cursor]) }));
  await writeFixtureFile(home, ".gemini/settings.json", JSON.stringify({ mcpServers: Object.fromEntries([OTHER_MCP_CASES.gemini]) }));
  await writeFixtureFile(home, ".claude/settings.json", JSON.stringify({
    permissions: PERMISSION_CASES,
    statusLine: { type: "command", command: `${home}/bin/status.sh --token ZZ9status02a` },
    env: { SECRET_SETTING: "ZZ9settingsenv03" },
    enabledPlugins: { "p1@market": true },
    extraKnownMarketplaces: { m1: { source: { source: "github", repo: "o/r" } } },
    theme: "ZZ9theme04",
  }));

  const pluginOne = path.join(home, ".claude/plugins/cache/market/p1/1.0.0");
  await writeFixtureFile(pluginOne, ".claude-plugin/plugin.json", JSON.stringify({
    name: "p1",
    version: "1.0.0",
    description: "desc",
    mcpServers: { s1: { command: "x", env: { FOO: "ZZ9pmcp01a" }, args: ["postgres://u:ZZ9pmcp01b@h/db"] } },
    lspServers: { l1: { command: "ls", env: { LSP_X: "ZZ9lsp02a" }, args: ["--password", "ZZ9lsp02b"] } },
    hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "curl -u u:ZZ9hook03a https://x" }] }] },
    userConfig: { token: { default: "ZZ9userconf04" } },
    apps: "./config/apps.json",
    settings: { foo: { bar: "ZZ9pluginsettings05" } },
    customThing: { password: "ZZ9customkey06", other: "ZZ9customother06b" },
  }));
  await writeFixtureFile(pluginOne, "config/apps.json", JSON.stringify({ apps: { a: { id: "ZZ9apps07a", note: "x", secret_blob: "ZZ9apps07b", cred: "ZZ9apps07c" } } }));
  await writeFixtureFile(pluginOne, ".mcp.json", JSON.stringify({ mcpServers: { s2: { type: "http", url: "https://p.example.test/mcp", env: { OTHER: "ZZ9pdotmcp08" } } } }));
  const pluginTwo = path.join(home, ".claude/plugins/cache/market/p2/1.0.0");
  await writeFixtureFile(pluginTwo, ".claude-plugin/plugin.json", JSON.stringify({ name: "p2", version: "1.0.0", mcpServers: "./auth.json", apps: ".env" }));
  await writeFixtureFile(pluginTwo, "auth.json", JSON.stringify({ access_token_x: "ZZ9authjson09a", mcpServers: { z: { command: "x" } }, session: { id: "ZZ9session09b" } }));
  await writeFixtureFile(pluginTwo, ".env", "API_KEY=ZZ9dotenv10\nDB_HOST=x\n");
  await writeFixtureFile(home, ".claude/plugins/installed_plugins.json", JSON.stringify({
    version: 2,
    plugins: {
      "p1@market": [{ scope: "user", installPath: pluginOne, version: "1.0.0" }],
      "p2@market": [{ scope: "user", installPath: pluginTwo, version: "1.0.0" }],
    },
  }));

  await writeFixtureFile(home, ".codex/skills/leaky/SKILL.md", SKILL_TEXT);

  const expert = path.join(home, ".workbuddy/plugins/marketplaces/my-experts/plugins/mine");
  await writeFixtureFile(expert, ".codebuddy-plugin/plugin.json", JSON.stringify({
    name: "mine",
    version: "0.1",
    expertType: "agent",
    agentName: "mine",
    displayName: { zh: "我的" },
    agents: ["./agents/mine.md"],
    avatar: "avatars/expert.png",
    mcpServers: { s: { command: "x", env: { FOO: "ZZ9expmcp01a" }, headers: { "X-A": "ZZ9exphdr01b" } } },
    env: { A: "ZZ9expenv01c" },
    defaultInitPrompt: { zh: "token is ZZ9expprompt02" },
    quickPrompts: [{ zh: "password: ZZ9expquick03" }],
    description: "secret ZZ9expdesc04",
  }));
  await writeFixtureFile(expert, "agents/mine.md", "---\nname: mine\ndescription: x\n---\nAPI_KEY=ZZ9expmd05\nUse password: ZZ9expmd06\n");
  await writeFixtureFile(expert, ".mcp.json", JSON.stringify({ mcpServers: { s: { env: { A: "ZZ9expdotmcp07" } } } }));
  await writeFixtureFile(home, ".workbuddy/settings.json", JSON.stringify({ sandbox: { extraAllowWrite: ["/a"] }, enabledPlugins: {} }));
  await writeFixtureFile(home, ".hermes/SOUL.md", "# Hermes soul\nPassword: ZZ9hermes01\n");
  await writeFixtureFile(home, ".hermes/config.yaml", "model:\n  default: x\n  provider: ZZ9hermesprov02\n");
}
