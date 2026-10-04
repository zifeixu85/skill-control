"use client";

import { joinNames } from "../../lib/format";
import { ConfigDetailView } from "../files/ConfigDetailView";
import { useData } from "../providers/DataProvider";
import { LetterLogo } from "../ui/Avatar";
import { Drawer } from "./Drawer";

export function McpDrawer({ name, onClose }: { name: string; onClose: () => void }) {
  const { integrations, agentName } = useData();
  const row = integrations.data?.mcpMatrix.find((item) => item.name === name);
  const servers = (integrations.data?.mcpServers || []).filter((server) => server.name === name);
  const secrets = [...new Set(servers.flatMap((server) => server.likelySecretFields))];
  return (
    <Drawer
      label={`${name} MCP 配置`}
      icon={<LetterLogo text={name} />}
      title={name}
      subtitle={`MCP 服务 · ${row ? `${row.agentIds.length} 个 Agent 里有配置` : "配置"}`}
      onClose={onClose}
      wide
    >
      <div className="insp-body">
        {secrets.length ? (
          <p className="safe-note danger">
            明文密钥写在 {joinNames(secrets)}。建议改用环境变量引用，比如 <code>{"${API_KEY}"}</code>。
          </p>
        ) : null}
        <ConfigDetailView
          kind="mcp"
          id={name}
          filesTitle={`各 Agent 里的配置原文${row ? `（${joinNames(row.agentIds.map(agentName))}）` : ""}`}
          note={row && row.agentIds.length > 1 ? "点上方标签切换不同 Agent 的配置。" : undefined}
        />
      </div>
    </Drawer>
  );
}
