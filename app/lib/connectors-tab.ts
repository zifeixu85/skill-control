import { persistentStore } from "./storage";

/**
 * 连接器与 MCP has three tabs: how Agents reach outside services (connectors, MCP), the
 * command-line tools they call, and the keys both of those use.
 */
export type ConnectorsTab = "mcp" | "cli" | "secrets";

export const CONNECTORS_TABS: { id: ConnectorsTab; label: string }[] = [
  { id: "mcp", label: "连接器与 MCP" },
  { id: "cli", label: "命令行工具" },
  { id: "secrets", label: "密钥" },
];

export const connectorsTabStore = persistentStore<ConnectorsTab>("connectors-tab", "mcp", (value) => value === "mcp" || value === "cli" || value === "secrets");
