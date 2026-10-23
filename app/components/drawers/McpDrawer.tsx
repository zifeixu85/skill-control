"use client";

import { joinNames } from "../../lib/format";
import { ConfigDetailView } from "../files/ConfigDetailView";
import { useData } from "../providers/DataProvider";
import { LetterLogo } from "../ui/Avatar";
import { Drawer } from "./Drawer";
import { SparkIcon } from "../icons";
import { ACTION_NOTES, useCopyRemedy } from "../ui/RemedyPanel";

/** Names and places only — never a value. */
function mcpSecretPrompt(name: string, fields: string[], agents: string[]): string {
  return `MCP 服务「${name}」的配置里有明文密钥（字段：${fields.join("、")}${agents.length ? `；配置在 ${agents.join("、")} 里` : ""}）。请帮我把这些值改成环境变量引用：配置里只写变量名，把值放进 shell 环境或系统钥匙串；先告诉我要改哪些文件，备份后再改，改完确认这个 MCP 服务还能启动。不要在回复里显示密钥的值。`;
}

export function McpDrawer({ name, onClose }: { name: string; onClose: () => void }) {
  const { integrations, agentName } = useData();
  const copy = useCopyRemedy();
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
          <div className="secret-fix">
            <p className="safe-note danger">
              明文密钥写在 {joinNames(secrets)}。建议改用环境变量引用，比如 <code>{"${API_KEY}"}</code>。
            </p>
            <div className="fix-act">
              <button type="button" className="btn sm" title={ACTION_NOTES.copy} onClick={() => void copy(mcpSecretPrompt(name, secrets, row?.agentIds.map(agentName) || []), "ai")}>
                <SparkIcon />
                复制 AI 指令
              </button>
              <small className="act-note">{ACTION_NOTES.copy}</small>
            </div>
          </div>
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
