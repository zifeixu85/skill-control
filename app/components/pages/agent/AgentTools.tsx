"use client";

import { isUnsupported, useResource } from "../../../hooks/useResource";
import type { AgentToolItem } from "../../../lib/agent-extras";
import { api, errorMessage } from "../../../lib/api";
import { EmptyState, Loading } from "../../ui/basics";

const KIND_LABELS: Record<string, string> = {
  builtin: "内置",
  toolset: "工具集",
  mcp: "MCP",
  connector: "连接器",
  "plugin-command": "插件",
  subagent: "子代理",
  permission: "权限规则",
  feature: "功能开关",
};

function enabledLabel(item: AgentToolItem): { label: string; tone: string } {
  if (item.kind === "permission") {
    if (item.enabled === true) return { label: "允许", tone: "" };
    if (item.enabled === false) return { label: "拒绝", tone: "danger" };
    return { label: "询问", tone: "warn" };
  }
  if (item.enabled === true) return { label: "已启用", tone: "" };
  if (item.enabled === false) return { label: "已关闭", tone: "mute" };
  return { label: "未知", tone: "mute" };
}

function ToolRow({ item }: { item: AgentToolItem }) {
  const state = enabledLabel(item);
  return (
    <li className="tool">
      <div className="tool-main">
        <code className="tool-name">{item.name}</code>
        {item.description ? <span>{item.description}</span> : null}
        {item.tools.length ? (
          <details>
            <summary>{item.tools.length} 个工具</summary>
            <div className="list-names">
              {item.tools.map((tool) => (
                <span key={tool}>{tool}</span>
              ))}
            </div>
          </details>
        ) : null}
      </div>
      <span className="tool-tags">
        {KIND_LABELS[item.kind] ? <span className="tag mute">{KIND_LABELS[item.kind]}</span> : null}
        <span className={`tag ${state.tone}`}>{state.label}</span>
      </span>
    </li>
  );
}

export function AgentTools({ agentId, agentName }: { agentId: string; agentName: string }) {
  const tools = useResource(`agent-tools:${agentId}`, () => api.agentTools(agentId));
  if (isUnsupported(tools.error)) {
    return <EmptyState title="本地服务还没有提供这项数据">更新 Skill Control 后可以查看 {agentName} 能用的工具、MCP 和权限规则。</EmptyState>;
  }
  if (tools.status === "error" && !tools.data) return <EmptyState tone="error" title="读取工具失败">{errorMessage(tools.error)}</EmptyState>;
  if (!tools.data) return <Loading label="正在读取工具…" rows={5} />;
  const { groups, notes } = tools.data;
  if (!groups.length) return <EmptyState title="没有找到工具配置">{notes.join(" ") || `${agentName} 没有可读取的工具或权限配置。`}</EmptyState>;
  return (
    <div className="tool-groups">
      {groups.map((group) => (
        <section key={group.id} className="tool-group" aria-label={group.label}>
          <h3>
            {group.label} <em>{group.items.length}</em>
            {group.source ? <small>{group.source}</small> : null}
          </h3>
          <ul>
            {group.items.map((item, index) => (
              <ToolRow key={`${item.name}-${index}`} item={item} />
            ))}
          </ul>
        </section>
      ))}
      {notes.length ? (
        <ul className="footnote-list">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
