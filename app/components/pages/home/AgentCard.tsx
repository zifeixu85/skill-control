"use client";

import type { CSSProperties } from "react";
import { agentMeta, tintFor } from "../../../lib/agents";
import { COST_HINT, formatCost } from "../../../lib/cost";
import { formatCompact, shortTitle } from "../../../lib/format";
import type { PageId } from "../../../lib/navigation";
import { componentsOf, mergePlugins } from "../../../lib/plugins";
import type { ActivityAgent } from "../../../lib/types";
import { isIndexing, SESSIONS_HINT, type UsageSummary } from "../../../lib/usage";
import { useData } from "../../providers/DataProvider";
import { useNav } from "../../providers/NavProvider";
import { AgentAvatar } from "../../ui/Avatar";
import { pluginAgentStore } from "../PluginsPage";

interface Stat {
  label: string;
  value: number | null;
  onClick?: () => void;
}

/**
 * The "近 30 天 …" line. The usage index's count (sessions active in the window) wins when it
 * is ready, so this line matches the figures on the cards and the 数据 page; the activity scan
 * (session files touched in the window) is the fallback while usage is still being counted.
 */
export function activityLine(activity: ActivityAgent | undefined, usage?: { sessions: number; activeDays: number } | null): string {
  if (usage && usage.sessions > 0) return `近 30 天 ${usage.sessions} 个会话 · ${usage.activeDays} 天在用`;
  if (!activity || activity.status === "unknown" || (!activity.files30d && !activity.tokens30d)) {
    return "近 30 天暂无记录";
  }
  if (activity.basis === "tokens") {
    return [activity.activeDays30d ? `近 30 天 ${activity.activeDays30d} 天在用` : "近 30 天", `${formatCompact(activity.tokens30d)} tokens`].join(" · ");
  }
  return `近 30 天 ${activity.files30d} 个会话 · ${activity.activeDays30d} 天在用`;
}

/**
 * Tokens and 预估费用 for the last 30 days as one quiet line under the activity line,
 * in the same text style. Every figure is an estimate, so the tooltip only says how it's made.
 */
function usageLine(data: UsageSummary | null | undefined, agentId: string): { text: string; title?: string; busy?: boolean } | null {
  if (!data) return { text: "用量统计中…", busy: true };
  const agent = data.agents.find((item) => item.agentId === agentId);
  if (!agent) return isIndexing(data.status, data.index) ? { text: "用量统计中…", busy: true } : null;
  if (!agent.tokens?.total && agent.costUsd === null) return null;
  // Cost first, so a narrow card cuts the token count rather than the figure people look for.
  const parts = [agent.costUsd !== null ? `预估费用 ${formatCost(agent.costUsd)}` : "", agent.tokens?.total ? `${formatCompact(agent.tokens.total)} tokens` : ""].filter(Boolean);
  return { text: parts.join(" · "), title: COST_HINT };
}

export function AgentCard({ agentId }: { agentId: string }) {
  const { agentsById, activityById, integrations, capabilities, views, usage } = useData();
  const { go } = useNav();
  const agent = agentsById.get(agentId);
  const usageAgent = usage.data?.agents.find((item) => item.agentId === agentId) || null;
  const usageText = usageLine(usage.data, agentId);
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
            value: plugins.reduce((sum, plugin) => sum + componentsOf(plugin).agents.length, 0),
          }
        : agentId === "workbuddy" || agentId === "office-raccoon"
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
        <div className="acard-title">
          <div className="acard-name-row">
            <h2>
              <button type="button" className="acard-name" onClick={() => go("agent", { agentId })} title={`查看 ${meta.name} 的详情`}>
                {meta.name}
              </button>
            </h2>
            <span className="tag">常用</span>
          </div>
          <div className="meta" title={SESSIONS_HINT}>
            {activityLine(activityById.get(agentId), usageAgent)}
          </div>
          {usageText ? (
            <div className="meta" title={usageText.title} aria-busy={usageText.busy || undefined}>
              {usageText.text}
            </div>
          ) : null}
        </div>
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
