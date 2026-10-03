import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeFixtureFile(root, relative, content) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  return target;
}

export async function createSmartOrderFixture(home) {
  const root = path.join(home, ".smartorder");
  const skill = (name, title) => `---\nname: ${name}\ndescription: ${title}的合成测试说明。\n---\n# ${title}\n\n只用于本地测试。\n`;
  await writeFixtureFile(root, "skills/local-demo/SKILL.md", skill("local-demo", "本地订单助手"));
  await writeFixtureFile(root, "skills/.system/system-demo/SKILL.md", skill("system-demo", "内置示例"));
  await writeFixtureFile(root, "skills/disabled-demo/SKILL.md", skill("disabled-demo", "停用示例"));
  const plugin = "plugins/cache/demo-market/order-demo/V1";
  await writeFixtureFile(root, `${plugin}/.codex-plugin/plugin.json`, JSON.stringify({
    name: "order-demo", version: "V1", skills: "./skills/", interface: { displayName: { zh: "酒店订单示例" } },
  }));
  await writeFixtureFile(root, `${plugin}/skills/plugin-demo/SKILL.md`, skill("plugin-demo", "酒店订单示例"));
  await writeFixtureFile(root, `${plugin}/.mcp.json`, JSON.stringify({ mcpServers: {
    "plugin-orders": { command: "secret-command-should-not-leak", args: ["secret-arg"], env: { TOKEN: "secret-plugin-token" } },
  } }));
  await writeFixtureFile(root, "plugins/cache/demo-market/unused/V1/skills/unused/SKILL.md", skill("unused", "仅缓存的技能"));
  await writeFixtureFile(root, "codex-marketplaces/demo-market/prod/current/plugins/catalog/skills/catalog/SKILL.md", skill("catalog", "市场清单"));
  await writeFixtureFile(root, "codex-marketplaces/demo-market/prod/previous/plugins/old/skills/old/SKILL.md", skill("old", "历史版本"));
  const config = `
[mcp_servers.orders]
url = "https://user:secret-password@example.test/secret-path?key=secret-query#secret-fragment"
enabled = true
enabled_tools = ["query_orders"]
disabled_tools = ["delete_order"]
default_tools_approval_mode = "prompt"
tool_timeout_sec = 45
bearer_token = "secret-bearer"
env_http_headers = { Authorization = "secret-header-variable" }

[mcp_servers.local]
command = "secret-command"
args = ["secret-argument"]
env = { KEY = "secret-local-key" }
enabled = false
enabled_tools = []

[plugins."order-demo@demo-market"]
enabled = true
[plugins."disabled@demo-market"]
enabled = false

[[skills.config]]
path = "skills/disabled-demo"
enabled = false
`;
  await writeFixtureFile(root, "config.toml", config);
  return { root, pluginRoot: path.join(root, plugin), config };
}
