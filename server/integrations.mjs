import { homedir } from "node:os";
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
  return {
    assets: codexPlugins.assets,
    roots,
    codexConnectors,
    payload: {
      plugins: [...codexPlugins.plugins, ...installed.flatMap((result) => result.plugins)],
      connectors: codexConnectors.connectors,
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
