"use client";

import type { CSSProperties } from "react";
import { agentMeta, tintFor } from "../../../lib/agents";
import { formatCompact, shortTitle } from "../../../lib/format";
import type { PageId } from "../../../lib/navigation";
import { mergePlugins } from "../../../lib/plugins";
import type { ActivityAgent } from "../../../lib/types";
import { useData } from "../../providers/DataProvider";
import { useNav } from "../../providers/NavProvider";
import { AgentAvatar } from "../../ui/Avatar";
import { pluginAgentStore } from "../PluginsPage";

interface Stat {
  label: string;
  value: number | null;
  onClick?: () => void;
}

export function activityLine(activity: ActivityAgent | undefined): string {
  if (!activity || activity.status === "unknown" || (!activity.files30d && !activity.tokens30d)) {
    return "近 30 天暂无记录";
  }
  if (activity.basis === "tokens") {
    return [activity.activeDays30d ? `近 30 天 ${activity.activeDays30d} 天在用` : "近 30 天", `${formatCompact(activity.tokens30d)} tokens`].join(" · ");
  }
  return `近 30 天 ${activity.files30d} 个会话 · ${activity.activeDays30d} 天在用`;
}

export function AgentCard({ agentId }: { agentId: string }) {
  const { agentsById, activityById, integrations, capabilities, views } = useData();
  const { go } = useNav();
  const agent = agentsById.get(agentId);
  const meta = agentMeta(agentId, agent);
  const plugins = mergePlugins(integrations.data?.plugins || []).filter((plugin) => plugin.agentId === agentId);
  const mcp = (integrations.data?.mcpServers || []).filter((server) => server.agentId === agentId);
  const profiles = (capabilities.data?.products || []).find((product) => product.id === agentId)?.items || [];
  const goTo = (page: PageId, filter?: string) => () => go(page, filter ? { filter } : {});
  const openPlugins = () => {
    pluginAgentStore.set(agentId);
    go("plugins");
  };

  const extra: Stat =
    agentId === "codex"
      ? { label: "连接器", value: integrations.data?.connectors.length ?? null, onClick: goTo("connectors") }
      : agentId === "claude"
        ? {
            label: "子代理",
            value: plugins.reduce((sum, plugin) => sum + (plugin.components.agents?.length || 0), 0),
          }
        : agentId === "workbuddy"
          ? { label: "专家", value: profiles.length, onClick: goTo("experts") }
          : agentId === "hermes"
            ? { label: "Profile", value: profiles.length, onClick: goTo("experts") }
            : ["openclaw", "qclaw"].includes(agentId)
              ? { label: "Agent", value: profiles.length, onClick: goTo("experts") }
              : { label: "活跃天数", value: activityById.get(agentId)?.activeDays30d ?? null };
  const stats: Stat[] = [
    { label: "技能", value: agent?.skillCount ?? null, onClick: goTo("skills", `agent:${agentId}`) },
    { label: "插件", value: integrations.data ? plugins.length : null, onClick: openPlugins },
    extra,
    { label: "MCP", value: integrations.data ? mcp.length : null, onClick: goTo("connectors") },
  ];

  const used = views
    .filter((view) => (view.usage[agentId] || 0) > 0)
    .sort((left, right) => (right.usage[agentId] || 0) - (left.usage[agentId] || 0))
    .slice(0, 5);
  const max = used[0]?.usage[agentId] || 1;

  return (
    <article className="acard" style={{ "--tint": tintFor(meta.color) } as CSSProperties}>
      <div className="acard-head">
        <AgentAvatar id={agentId} size="lg" />
        <div>
          <h2>{meta.name}</h2>
          <div className="meta">{activityLine(activityById.get(agentId))}</div>
        </div>
        <span className="tag" style={{ marginLeft: "auto" }}>
          常用
        </span>
      </div>
      <div className="stats">
        {stats.map((stat) => (
          <button
            key={stat.label}
            type="button"
            className={`stat ${stat.value === null || stat.value === 0 ? "na" : ""}`}
            disabled={!stat.onClick}
            onClick={stat.onClick}
          >
            <b>{stat.value === null ? "—" : stat.value}</b>
            <span>{stat.label}</span>
          </button>
        ))}
      </div>
      <div className="used">
        <h3>最近 30 天用得最多的技能</h3>
        {used.length ? (
          <ol>
            {used.map((view) => (
              <li key={view.id}>
                <button type="button" className="nm" title={view.title} onClick={() => go("skills", { skillId: view.id })}>
                  {shortTitle(view.title)}
                </button>
                <span className="bar" aria-hidden="true">
                  <i style={{ width: `${Math.max(6, ((view.usage[agentId] || 0) / max) * 100)}%` }} />
                </span>
                <span className="v">{view.usage[agentId]} 次</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="empty-line">还没有使用记录</p>
        )}
      </div>
    </article>
  );
}
