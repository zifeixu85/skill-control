import { homedir } from "node:os";
import { scanClaudePlugins } from "./claude-plugins.mjs";
import { scanCodexConnectors, scanCodexPlugins } from "./codex-plugins.mjs";
import { scanMcpInventory } from "./mcp-inventory.mjs";

/**
 * Aggregates read-only Agent integrations: plugins (Codex, Claude Code), Codex connectors
 * and MCP servers. Each scanner is isolated: a failure becomes a generic warning and an
 * empty section, never a failed request. `assets` maps opaque ids to manifest-referenced
 * images and must stay server-side; only `payload` is returned over HTTP.
 */

const emptyCodexPlugins = () => ({ available: false, plugins: [], marketplaces: [], warnings: [], assets: new Map() });
const emptyClaudePlugins = () => ({ available: false, plugins: [], marketplaces: [], warnings: [] });
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
  scanners = { scanCodexPlugins, scanClaudePlugins, scanMcpInventory, scanCodexConnectors },
) {
  const [codexPlugins, claudePlugins, mcp] = await Promise.all([
    isolate(() => scanners.scanCodexPlugins(homeDirectory), emptyCodexPlugins, "Codex 插件"),
    isolate(() => scanners.scanClaudePlugins(homeDirectory), emptyClaudePlugins, "Claude Code 插件"),
    isolate(() => scanners.scanMcpInventory(homeDirectory), emptyMcp, "MCP 配置"),
  ]);
  const codexConnectors = await isolate(
    () => scanners.scanCodexConnectors(homeDirectory, { plugins: codexPlugins.plugins }),
    () => emptyCodexConnectors(),
    "Codex 连接器",
  );
  return {
    assets: codexPlugins.assets,
    codexConnectors,
    payload: {
      plugins: [...codexPlugins.plugins, ...claudePlugins.plugins],
      connectors: codexConnectors.connectors,
      mcpServers: mcp.servers,
      mcpMatrix: mcp.matrix,
      sources: {
        codex: {
          available: codexPlugins.available,
          marketplaces: codexPlugins.marketplaces,
          connectorsCachedAt: codexConnectors.cachedAt,
        },
        claude: {
          available: claudePlugins.available,
          marketplaces: claudePlugins.marketplaces,
        },
      },
      warnings: [
        ...codexPlugins.warnings,
        ...codexConnectors.warnings,
        ...claudePlugins.warnings,
        ...mcp.warnings,
      ],
      scannedAt: new Date().toISOString(),
    },
  };
}
