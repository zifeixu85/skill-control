import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { createdAtOf } from "./fs-safe.mjs";
import { scanClaudePlugins, scanWorkBuddyPlugins } from "./installed-plugins.mjs";
import { scanHermesPlugins } from "./hermes.mjs";
import { scanOpenClawPlugins } from "./openclaw.mjs";
import { detectRelatedProducts } from "./related-products.mjs";
import { scanCodexConnectors, scanCodexPlugins } from "./codex-plugins.mjs";
import { scanMcpInventory } from "./mcp-inventory.mjs";

/**
 * Aggregates read-only Agent integrations: plugins (Codex, Claude Code), Codex connectors
 * and MCP servers. Each scanner is isolated: a failure becomes a generic warning and an
 * empty section, never a failed request. `assets` maps opaque ids to manifest-referenced
 * images and must stay server-side; only `payload` is returned over HTTP.
 */

const emptyCodexPlugins = () => ({
  available: false,
  plugins: [],
  marketplaces: [],
  warnings: [],
  assets: new Map(),
  roots: new Map(),
});
const emptyInstalledPlugins = () => ({
  available: false,
  plugins: [],
  marketplaces: [],
  warnings: [],
  roots: new Map(),
});
const emptyMcp = () => ({ servers: [], matrix: [], warnings: [] });
export const emptyCodexConnectors = (warning) => ({
  available: false,
  agentId: "codex",
  source: "codex-cache",
  cachedAt: null,
  connectors: [],
  warnings: warning ? [warning] : [],
});

async function isolate(task, fallback, label) {
  try {
    return await task();
  } catch {
    const value = fallback();
    value.warnings = [...(value.warnings || []), `${label}读取失败，已跳过。`];
    return value;
  }
}

/** installedAt / updatedAt of each plugin's folder (sort keys; the folder itself stays server-side). */
async function withFolderTimes(plugins, roots) {
  return Promise.all(
    plugins.map(async (plugin) => {
      const root = roots.get(plugin.key || `codex:${plugin.id}`);
      const info = root ? await stat(root).catch(() => null) : null;
      return info ? { ...plugin, installedAt: createdAtOf(info), updatedAt: new Date(info.mtimeMs).toISOString() } : { ...plugin, installedAt: null, updatedAt: null };
    }),
  );
}

/**
 * Connectors for the connectors page: the providing plugins' names and icon, and an auth
 * status. Codex caches a connector's tools only after the app was connected, so cached
 * tools mean "connected"; nothing else about the account is read.
 */
function withConnectorDetails(connectors, plugins) {
  const byId = new Map(plugins.filter((plugin) => plugin.agentId === "codex").map((plugin) => [plugin.id, plugin]));
  return connectors.map((connector) => {
    const providers = connector.providedByPlugins.map((id) => byId.get(id)).filter(Boolean);
    const icon = providers.find((plugin) => plugin.logo)?.logo || null;
    return {
      ...connector,
      providers: providers.map((plugin) => ({ id: plugin.id, name: plugin.displayName || plugin.id })),
      iconAssetId: icon,
      auth: connector.toolCount > 0 ? { status: "connected", basis: "Codex 已缓存它的工具列表（只有连接过的应用才会有）" } : { status: "unknown", basis: "没有缓存的工具列表" },
    };
  });
}

export async function scanIntegrations(
  homeDirectory = homedir(),
  overrides = {},
) {
  const scanners = {
    scanCodexPlugins,
    scanClaudePlugins,
    scanWorkBuddyPlugins,
    scanHermesPlugins,
    scanOpenClawPlugins: () => scanOpenClawPlugins("openclaw", homeDirectory),
    scanQClawPlugins: () => scanOpenClawPlugins("qclaw", homeDirectory),
    scanMcpInventory,
    scanCodexConnectors,
    detectRelatedProducts,
    ...overrides,
  };
  const [codexPlugins, claudePlugins, workbuddyPlugins, hermesPlugins, openclawPlugins, qclawPlugins, mcp, relatedProducts] =
    await Promise.all([
      isolate(() => scanners.scanCodexPlugins(homeDirectory), emptyCodexPlugins, "Codex 插件"),
      isolate(() => scanners.scanClaudePlugins(homeDirectory), emptyInstalledPlugins, "Claude Code 插件"),
      isolate(() => scanners.scanWorkBuddyPlugins(homeDirectory), emptyInstalledPlugins, "WorkBuddy 插件"),
      isolate(() => scanners.scanHermesPlugins(homeDirectory), emptyInstalledPlugins, "Hermes 插件"),
      isolate(() => scanners.scanOpenClawPlugins(homeDirectory), emptyInstalledPlugins, "OpenClaw 插件"),
      isolate(() => scanners.scanQClawPlugins(homeDirectory), emptyInstalledPlugins, "QClaw 插件"),
      isolate(() => scanners.scanMcpInventory(homeDirectory), emptyMcp, "MCP 配置"),
      scanners.detectRelatedProducts(homeDirectory).catch(() => []),
    ]);
  const codexConnectors = await isolate(
    () => scanners.scanCodexConnectors(homeDirectory, { plugins: codexPlugins.plugins }),
    () => emptyCodexConnectors(),
    "Codex 连接器",
  );
  const installed = [claudePlugins, workbuddyPlugins, hermesPlugins, openclawPlugins, qclawPlugins];
  // Plugin roots stay server-side; keys are `codex:<id>` or the plugin key.
  const roots = new Map([
    ...[...(codexPlugins.roots || new Map())].map(([id, root]) => [`codex:${id}`, root]),
    ...installed.flatMap((result) => [...(result.roots || new Map())]),
  ]);
  const plugins = await withFolderTimes([...codexPlugins.plugins, ...installed.flatMap((result) => result.plugins)], roots);
  return {
    assets: codexPlugins.assets,
    roots,
    codexConnectors,
    payload: {
      plugins,
      connectors: withConnectorDetails(codexConnectors.connectors, plugins),
      mcpServers: mcp.servers,
      mcpMatrix: mcp.matrix,
      relatedProducts,
      sources: {
        codex: {
          available: codexPlugins.available,
          marketplaces: codexPlugins.marketplaces,
          connectorsCachedAt: codexConnectors.cachedAt,
        },
        claude: { available: claudePlugins.available, marketplaces: claudePlugins.marketplaces },
        workbuddy: { available: workbuddyPlugins.available, marketplaces: workbuddyPlugins.marketplaces },
        hermes: { available: hermesPlugins.available },
        openclaw: { available: openclawPlugins.available },
        qclaw: { available: qclawPlugins.available },
      },
      warnings: [
        ...codexPlugins.warnings,
        ...codexConnectors.warnings,
        ...installed.flatMap((result) => result.warnings),
        ...mcp.warnings,
      ],
      scannedAt: new Date().toISOString(),
    },
  };
}
