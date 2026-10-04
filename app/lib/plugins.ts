import { countChip, type ChipSpec } from "./chips";
import type { Connector, Plugin, PluginComponents } from "./types";

/** Components with every list present, whatever the scanner returned. */
export function componentsOf(plugin: Plugin): Required<PluginComponents> {
  const raw: Partial<PluginComponents> = plugin.components || {};
  const list = <T,>(value: T[] | undefined): T[] => (Array.isArray(value) ? value : []);
  return {
    skills: list(raw.skills),
    mcpServers: list(raw.mcpServers),
    apps: list(raw.apps),
    hooks: Boolean(raw.hooks),
    agents: list(raw.agents),
    commands: list(raw.commands),
    channels: list(raw.channels),
  };
}

export interface PluginView extends Plugin {
  /** Other cached versions or scopes merged under the same name. */
  variants: number;
}

function pluginScore(plugin: Plugin): number {
  const components = componentsOf(plugin);
  return (
    (plugin.enabled === true ? 100 : 0) +
    (plugin.scope === "user" ? 10 : 0) +
    components.skills.length +
    components.mcpServers.length * 2 +
    components.apps.length
  );
}

/** One card per Agent + plugin name; keeps the most complete (enabled first) variant. */
export function mergePlugins(plugins: Plugin[]): PluginView[] {
  const merged = new Map<string, PluginView>();
  for (const plugin of plugins) {
    if (plugin.kind === "expert") continue;
    const key = `${plugin.agentId}:${plugin.name.toLowerCase()}`;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...plugin, variants: 0 });
    } else if (pluginScore(plugin) > pluginScore(current)) {
      merged.set(key, { ...plugin, variants: current.variants + 1 });
    } else {
      merged.set(key, { ...current, variants: current.variants + 1 });
    }
  }
  return [...merged.values()].sort(
    (left, right) =>
      Number(right.enabled === true) - Number(left.enabled === true) ||
      (left.displayName || left.name).localeCompare(right.displayName || right.name, "zh-Hans-CN"),
  );
}

export type PluginStateTone = "ok" | "mute" | "warn";

export function pluginState(plugin: Plugin): { label: string; tone: PluginStateTone } {
  if (plugin.enabled === true) return { label: "已启用", tone: "ok" };
  if (plugin.enabled === false) return { label: "已停用", tone: "mute" };
  if (plugin.source === "codex-plugin-cache") return { label: "只在缓存里", tone: "mute" };
  if (plugin.scope === "local" || plugin.scope === "project") return { label: "按项目启用", tone: "mute" };
  return { label: "未确认启用", tone: "mute" };
}

/** What a plugin brings, as card chips: kinds (连接器, MCP, Hook) then counts. */
export function pluginInside(plugin: Plugin): ChipSpec[] {
  const components = componentsOf(plugin);
  const chips: ChipSpec[] = [];
  if (components.apps.length) chips.push({ id: "apps", kind: "kind", tone: "info", text: "连接器" });
  if (components.mcpServers.length) chips.push({ id: "mcp", kind: "kind", text: "MCP" });
  if (components.hooks) chips.push({ id: "hooks", kind: "kind", text: "Hook" });
  if (components.skills.length) chips.push(countChip("skills", components.skills.length, " 个技能"));
  if (components.agents.length) chips.push(countChip("agents", components.agents.length, " 个子代理"));
  if (components.commands.length) chips.push(countChip("commands", components.commands.length, " 个命令"));
  if (components.channels.length) chips.push(countChip("channels", components.channels.length, " 个频道"));
  if (!chips.length) chips.push({ id: "config-only", kind: "kind", text: "只有配置" });
  return chips;
}

export function pluginConnectors(plugin: Plugin, connectors: Connector[]): Connector[] {
  const declared = new Set(componentsOf(plugin).apps.map((app) => app.connectorId).filter(Boolean));
  return connectors.filter(
    (connector) =>
      declared.has(connector.id) ||
      (connector.providedByPlugins || []).some(
        (id) => id === plugin.id || id.split("@")[0] === plugin.name.toLowerCase(),
      ),
  );
}

/** `/api/config-detail?kind=plugin` id: `<agent>:<name@marketplace>`. */
export const pluginDetailId = (plugin: Plugin) => `${plugin.agentId}:${plugin.id}`;

export const PLUGIN_SOURCE_NOTES: Record<string, string> = {
  codex: "读取自 ~/.codex/config.toml 和 Codex 插件缓存。安装、启用和账号授权仍在 Codex 里完成。",
  claude: "读取自 ~/.claude/plugins 和 settings.json。按项目安装的插件只在对应项目里启用。",
  workbuddy: "读取自 ~/.workbuddy/plugins。插件在 WorkBuddy 里安装和启用。",
  hermes: "读取自 ~/.hermes/plugins 和 config.yaml。",
  openclaw: "读取自 OpenClaw 的扩展目录和 openclaw.json。",
  qclaw: "读取自 QClaw 的扩展目录。QClaw 的插件由 QClaw 管理。",
};
