import { mkdir, symlink, truncate, utimes } from "node:fs/promises";
import path from "node:path";
import { writeFixtureFile } from "./smartorder.mjs";

export const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
export const SAFE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#24292f"/></svg>';

/** Every literal secret in these fixtures contains "secret-" so tests can grep serialized output. */
export const SECRET_PATTERN = /secret-/;

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const skill = (name, extra = "") =>
  `---\nname: ${name}\ndescription: Synthetic ${name} fixture.\n${extra}---\n# ${name}\n`;

async function setMtime(target, date) {
  await utimes(target, date, date);
}

export async function createCodexPluginFixture(home) {
  const codex = path.join(home, ".codex");
  const cache = path.join(codex, "plugins", "cache");
  await writeFixtureFile(codex, "config.toml", `
model = "fixture-model"

[mcp_servers.docs]
url = "https://docs.example.test/mcp/secret-path?token=secret-query-token"

[mcp_servers.local-tool]
command = "secret-command-binary"
args = ["--api-key=secret-arg-key", "--verbose"]
env = { API_TOKEN = "secret-env-token", REF_TOKEN = "\${MY_TOKEN}", PLAIN = "plain-value" }
enabled = false

[mcp_servers.remote]
url = "https://remote.example.test/mcp"
http_headers = { Authorization = "Bearer secret-header-token", "X-Trace" = "trace-value" }
bearer_token = "secret-bearer-literal"

[plugins."github@openai-curated"]
enabled = true

[plugins."gmail@openai-curated"]
enabled = false

[plugins."ghost@openai-curated"]
enabled = true

[plugins."chrome@openai-bundled"]
enabled = true

[marketplaces.personal]
source_type = "local"
source = "/secret-local-marketplace"
`);

  const github = path.join(cache, "openai-curated", "github", "bd2122cb");
  await writeFixtureFile(github, ".codex-plugin/plugin.json", json({
    name: "github",
    version: "bd2122cb",
    description: "Fixture GitHub plugin",
    author: { name: "Fixture Inc", url: "https://fixture.example.test/secret-author-path" },
    homepage: "https://github.example.test/secret-homepage-path?x=1",
    license: "MIT",
    keywords: ["git", "review"],
    skills: "./skills/",
    mcpServers: "./.mcp.json",
    apps: "./.app.json",
    interface: {
      displayName: "GitHub",
      shortDescription: "Triage PRs",
      longDescription: "Long description for the fixture.",
      developerName: "Fixture Inc",
      category: "Developer Tools",
      capabilities: ["Interactive", "Write"],
      brandColor: "#24292F",
      composerIcon: "./assets/icon.svg",
      logo: "./assets/logo.png",
      logoDark: "./assets/escape.png",
    },
  }));
  await writeFixtureFile(github, ".app.json", json({
    apps: { github: { id: "connector_github123", required: false } },
  }));
  await writeFixtureFile(github, ".mcp.json", json({
    mcpServers: {
      github: {
        type: "http",
        url: "https://api.github.example.test/secret-mcp-path",
        bearer_token_env_var: "GITHUB_TOKEN",
        http_headers: { Authorization: "Bearer secret-plugin-header" },
      },
    },
  }));
  await writeFixtureFile(github, "skills/gh-review/SKILL.md", skill("gh-review"));
  await writeFixtureFile(github, "skills/nested/gh-ci/SKILL.md", skill("gh-ci"));
  await writeFixtureFile(github, "assets/logo.png", PIXEL_PNG);
  await writeFixtureFile(github, "assets/icon.svg", SAFE_SVG);
  const outsideSkill = await writeFixtureFile(home, "outside/escaped-skill/SKILL.md", skill("escaped-secret-skill"));
  const outsideImage = await writeFixtureFile(home, "outside/escape.png", PIXEL_PNG);
  if (process.platform !== "win32") {
    await symlink(path.dirname(outsideSkill), path.join(github, "skills", "escaped"));
    await symlink(outsideImage, path.join(github, "assets", "escape.png"));
  }

  const gmail = path.join(cache, "openai-curated", "gmail", "0.1.0");
  await writeFixtureFile(gmail, ".codex-plugin/plugin.json", json({
    name: "gmail", version: "0.1.0", apps: "./.app.json",
    interface: { displayName: "Gmail" },
  }));
  await writeFixtureFile(gmail, ".app.json", json({ apps: { gmail: { id: "connector_gmail456" } } }));

  const remote = path.join(cache, "openai-curated-remote", "github", "0.1.12");
  await writeFixtureFile(remote, ".codex-plugin/plugin.json", json({
    name: "github", version: "0.1.12", apps: "./.app.json",
    interface: { displayName: "GitHub (remote)" },
  }));
  await writeFixtureFile(remote, ".app.json", json({ apps: { github: { id: "connector_github123" } } }));

  const chrome = path.join(cache, "openai-bundled", "chrome");
  for (const [version, date] of [["26.1.0", new Date("2026-08-01T00:00:00Z")], ["26.2.0", new Date("2026-09-01T00:00:00Z")]]) {
    await writeFixtureFile(path.join(chrome, version), ".codex-plugin/plugin.json", json({
      name: "chrome", version,
      hooks: { hooks: { Interrupt: [{ hooks: [{ type: "mcp_tool" }] }] } },
      interface: { displayName: `Chrome ${version}` },
    }));
    await setMtime(path.join(chrome, version), date);
  }
  if (process.platform !== "win32") {
    await symlink(path.join(chrome, "26.2.0"), path.join(chrome, "latest"));
  }

  const outsidePlugin = path.join(home, "outside-plugin");
  await writeFixtureFile(outsidePlugin, "1.0.0/.codex-plugin/plugin.json", json({
    name: "escape-plugin", version: "1.0.0", interface: { displayName: "secret-escaped-plugin" },
  }));
  if (process.platform !== "win32") {
    await mkdir(path.join(cache, "evil-market"), { recursive: true });
    await symlink(outsidePlugin, path.join(cache, "evil-market", "escape-plugin"));
  }

  const huge = path.join(cache, "big-market", "huge", "1.0.0", ".codex-plugin", "plugin.json");
  await writeFixtureFile(path.dirname(huge), "plugin.json", "");
  await truncate(huge, 300_000);
  await writeFixtureFile(cache, "bad-market/broken/1.0.0/.codex-plugin/plugin.json", "{ secret-broken-json");

  const tools = path.join(codex, "cache", "codex_apps_tools");
  const tool = (connectorId, connectorName, name, title) => ({
    server_name: "codex_apps",
    server_origin: { url: "https://secret-origin.example.test/x?key=secret-origin" },
    tool_name: name,
    tool_namespace: `codex_apps__${connectorName.toLowerCase()}`,
    namespace_description: `${connectorName} connector description`,
    connector_id: connectorId,
    connector_name: connectorName,
    plugin_display_names: [],
    tool: { name, title, description: "desc", inputSchema: { type: "object" } },
  });
  const oldFile = await writeFixtureFile(tools, "old.json", json({
    schema_version: 4, tools: [tool("connector_stale", "Stale", "stale_tool", "Stale tool")],
  }));
  await setMtime(oldFile, new Date("2026-06-01T00:00:00Z"));
  const newFile = await writeFixtureFile(tools, "new.json", json({
    schema_version: 4,
    tools: [
      tool("connector_github123", "GitHub", "list_prs", "List pull requests"),
      tool("connector_github123", "GitHub", "get_issue", "Get issue"),
      tool("connector_github123", "GitHub", "search", ""),
      tool("connector_hotline", "Hotline", "call", "Call"),
    ],
  }));
  await setMtime(newFile, new Date("2026-09-30T00:00:00Z"));
  return { codex, cache, github, chrome, tools, newFile };
}

export async function createClaudePluginFixture(home) {
  const claude = path.join(home, ".claude");
  const plugins = path.join(claude, "plugins");
  const warp = path.join(plugins, "cache", "claude-code-warp", "warp", "2.2.0");
  const designUser = path.join(plugins, "cache", "official", "frontend-design", "abc123");
  const designLocal = path.join(plugins, "cache", "official", "frontend-design", "unknown");
  const disabled = path.join(plugins, "cache", "official", "disabled-one", "1.0.0");
  const linked = path.join(plugins, "cache", "evil", "linked", "1");
  const outside = path.join(home, "outside-claude-plugin");
  const project = path.join(home, "Projects", "demo");

  await writeFixtureFile(warp, ".claude-plugin/plugin.json", json({
    name: "warp", version: "2.2.0", description: "Warp fixture", author: { name: "Warp", email: "secret-email@example.test" },
  }));
  await writeFixtureFile(warp, "hooks/hooks.json", json({ hooks: {} }));
  await writeFixtureFile(warp, "commands/alpha.md", "# alpha\n");
  await writeFixtureFile(warp, "commands/group/beta.md", "# beta\n");
  await writeFixtureFile(warp, "agents/reviewer.md", "# reviewer\n");
  await writeFixtureFile(warp, "skills/warp-skill/SKILL.md", skill("warp-skill"));
  await writeFixtureFile(warp, ".mcp.json", json({
    mcpServers: { warpmcp: { command: "secret-claude-cmd", env: { TOKEN: "secret-claude-plugin-token" } } },
  }));
  await writeFixtureFile(designUser, ".claude-plugin/plugin.json", json({ name: "frontend-design", description: "Design fixture" }));
  await writeFixtureFile(designUser, "skills/frontend-design/SKILL.md", skill("frontend-design"));
  await writeFixtureFile(designLocal, "skills/frontend-design/SKILL.md", skill("frontend-design"));
  await writeFixtureFile(disabled, ".claude-plugin/plugin.json", "{ secret-malformed");
  await writeFixtureFile(outside, ".claude-plugin/plugin.json", json({ name: "secret-outside-plugin" }));
  if (process.platform !== "win32") {
    await mkdir(path.dirname(linked), { recursive: true });
    await symlink(outside, linked);
  }

  await writeFixtureFile(plugins, "installed_plugins.json", json({
    version: 2,
    plugins: {
      "warp@claude-code-warp": [{ scope: "user", installPath: warp, version: "2.2.0", installedAt: "2026-09-01T00:00:00.000Z", lastUpdated: "2026-09-02T00:00:00.000Z", gitCommitSha: "abc" }],
      "frontend-design@official": [
        { scope: "local", projectPath: project, installPath: designLocal, version: "unknown" },
        { scope: "user", installPath: designUser, version: "abc123" },
      ],
      "disabled-one@official": [{ scope: "user", installPath: disabled, version: "1.0.0" }],
      "escaper@evil": [{ scope: "user", installPath: outside, version: "1" }],
      "linked@evil": [{ scope: "user", installPath: linked, version: "1" }],
    },
  }));
  await writeFixtureFile(plugins, "known_marketplaces.json", json({
    "claude-code-warp": { source: { source: "github", repo: "warp/secret-repo" }, installLocation: "/secret-location" },
    official: { source: { source: "git", url: "https://secret-git.example.test/repo.git" } },
  }));
  await writeFixtureFile(claude, "settings.json", json({
    enabledPlugins: { "warp@claude-code-warp": true, "disabled-one@official": false },
    env: { SECRET_VALUE: "secret-settings-env" },
  }));
  return { claude, plugins, warp, project };
}

export async function createMcpFixture(home) {
  const project = path.join(home, "Projects", "demo");
  await writeFixtureFile(home, ".claude.json", json({
    oauthAccount: { emailAddress: "secret-email@example.test" },
    mcpServers: {
      railway: { command: "npx", args: ["-y", "secret-railway-arg"] },
      api: {
        type: "http",
        url: "https://api.example.test/mcp?api_key=secret-claude-query",
        headers: { "X-API-Key": "secret-claude-header", "X-Env-Key": "${API_KEY}", Accept: "application/json" },
      },
    },
    projects: {
      [project]: {
        mcpServers: {
          "proj-db": { type: "stdio", command: "secret-db-cmd", env: { DB_PASSWORD: "secret-db-password", DB_HOST: "localhost" } },
        },
      },
      "/elsewhere/project": { mcpServers: {} },
    },
  }));
  await writeFixtureFile(home, ".cursor/mcp.json", json({
    mcpServers: { railway: { command: "npx", args: ["secret-cursor-arg"] } },
  }));
  await writeFixtureFile(home, ".gemini/settings.json", json({
    mcpServers: {
      pencil: { command: "pencil", env: { PENCIL_TOKEN: "$PENCIL_TOKEN" } },
      remote: { httpUrl: "https://gem.example.test/mcp/secret-gem-path", headers: { Authorization: "{env:GEM_TOKEN}" } },
      legacy: { url: "https://sse.example.test/sse", headers: { Cookie: "secret-gemini-cookie" } },
    },
  }));
  return { project };
}

/** Creates sized session files with controlled mtimes. Sizes are sparse, so this stays fast. */
export async function writeSessionFile(home, relative, size, mtime) {
  const target = await writeFixtureFile(home, relative, "");
  if (size) await truncate(target, size);
  await setMtime(target, mtime);
  return target;
}

