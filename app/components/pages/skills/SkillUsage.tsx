"use client";

import { useNow } from "../../../hooks/useNow";
import { isUnsupported, useResource } from "../../../hooks/useResource";
import { api } from "../../../lib/api";
import { formatCompact, formatMonthDay } from "../../../lib/format";
import type { SkillView } from "../../../lib/skill-model";
import { COST_HINT, estimatedPart, formatCost, sumCosts } from "../../../lib/cost";
import { CONFIDENCE_HINTS, confidenceLabel, fillSeries, localDate } from "../../../lib/usage";
import { InfoIcon } from "../../icons";
import { AreaChart } from "../../charts/AreaChart";
import { useData } from "../../providers/DataProvider";
import { AgentAvatar } from "../../ui/Avatar";
import { dayLabel } from "../usage/UsageAgentCard";

const DAYS = 90;

/** Summary-based counts, used until (or instead of) the per-skill endpoint. */
function SummaryCounts({ view }: { view: SkillView }) {
  const { primary } = useData();
  const agents = primary.filter((agentId) => view.usage[agentId] !== undefined);
  if (!agents.length) return <p className="muted small">常用 Agent 里还没有这个技能的使用记录。</p>;
  return (
    <div className="usebox">
      {agents.map((agentId) => (
        <div key={agentId}>
          <AgentAvatar id={agentId} />
          <div>
            <b>{view.usage[agentId] || 0}</b>
            <span>次 · 近 30 天</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** 90-day history from /api/usage/skill, with confidence per Agent. */
export function SkillUsage({ view }: { view: SkillView }) {
  const usage = useResource(`usage:skill:${view.techName}:${DAYS}`, () => api.usageSkill(view.techName, DAYS));
  const now = useNow();
  if (isUnsupported(usage.error) || usage.status === "error" || !usage.data) return <SummaryCounts view={view} />;
  // Tokens attributed to the skill count too, even without a recorded call (they carry its cost).
  const agents = usage.data.agents.filter((agent) => agent.total > 0 || agent.reportedTotal || agent.tokens > 0);
  if (!agents.length) return <p className="muted small">最近 {DAYS} 天没有使用记录。</p>;
  const end = localDate(now || null);
  // Cost only where tokens were attributed to the skill (Claude logs); null elsewhere.
  const priced = agents.filter((agent) => agent.costUsd !== null);
  const { costUsd: cost, costBasis: split } = sumCosts(priced);
  const daily = new Map<string, number>();
  for (const agent of agents) {
    for (const point of agent.series) daily.set(point.date, (daily.get(point.date) || 0) + point.count);
  }
  const series = end
    ? fillSeries(
        [...daily.entries()].map(([date, count]) => ({ date, sessions: count, tokens: 0, costUsd: 0 })),
        DAYS,
        end,
      )
    : [];
  return (
    <div className="skill-usage">
      <div className="usebox">
        {agents.map((agent) => (
          <div key={agent.agentId} title={agent.confidence ? CONFIDENCE_HINTS[agent.confidence] : undefined}>
            <AgentAvatar id={agent.agentId} />
            <div>
              <b>{agent.total}</b>
              <span>
                次 · {confidenceLabel(agent.confidence)}
                {agent.lastUsedAt ? ` · 最近 ${formatMonthDay(agent.lastUsedAt)}` : ""}
                {agent.reportedTotal ? ` · 累计 ${agent.reportedTotal}` : ""}
                {agent.tokens ? ` · ${formatCompact(agent.tokens)} tokens` : ""}
              </span>
            </div>
          </div>
        ))}
      </div>
      {priced.length ? (
        <p className="skill-cost" title={COST_HINT}>
          预估费用 <b>{formatCost(cost)}</b>
          <InfoIcon className="info-dot" aria-label={COST_HINT} />
          {estimatedPart(split) ? <small>{estimatedPart(split)}</small> : null}
        </p>
      ) : null}
      {series.some((point) => point.sessions > 0) ? (
        <AreaChart
          compact
          label={`${view.title} 最近 ${DAYS} 天每天的使用次数`}
          unit="次"
          points={series.map((point) => ({ label: dayLabel(point.date), value: point.sessions }))}
        />
      ) : null}
    </div>
  );
}
