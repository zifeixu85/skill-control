"use client";

import { useEffect, useState } from "react";
import { useNow } from "../../../hooks/useNow";
import { usePolling } from "../../../hooks/usePolling";
import { isUnsupported, useResource } from "../../../hooks/useResource";
import { api, errorMessage } from "../../../lib/api";
import { COST_HINT, estimatedPart, formatCost } from "../../../lib/cost";
import { formatCompact } from "../../../lib/format";
import { revealInPage } from "../../../lib/reveal";
import { fillSeries, isIndexing, localDate, SESSIONS_HINT, shouldPollUsage } from "../../../lib/usage";
import { AreaChart } from "../../charts/AreaChart";
import { InfoIcon } from "../../icons";
import { EmptyState, Loading, Segmented } from "../../ui/basics";
import { IndexProgress } from "../usage/IndexProgress";
import { dayLabel, SourceBadges } from "../usage/UsageAgentCard";
import { ModelBreakdown, ProjectBreakdown, SkillRanking, USAGE_SECTIONS, type UsageSection } from "./AgentUsageSections";

export const AGENT_USAGE_DAYS = 90;
const DAYS = AGENT_USAGE_DAYS;

type Metric = "sessions" | "tokens" | "cost";

/** The usage resource shared by the 概览 cards and this tab. */
export const useAgentUsage = (agentId: string) => useResource(`usage:agent:${agentId}:${DAYS}`, () => api.usageAgent(agentId, DAYS));

export function AgentUsage({
  agentId,
  agentName,
  focus,
  onFocused,
}: {
  agentId: string;
  agentName: string;
  /** A section to bring into view once the data is drawn (from a 概览 card). */
  focus?: UsageSection | null;
  onFocused?: () => void;
}) {
  const usage = useAgentUsage(agentId);
  const now = useNow();
  const [metric, setMetric] = useState<Metric>("sessions");
  const data = usage.data;
  usePolling(Boolean(data && shouldPollUsage(data.status, data.index)), () => void usage.reload(), 3_000);

  useEffect(() => {
    if (!focus || !data) return;
    const frame = window.requestAnimationFrame(() => {
      revealInPage(document.getElementById(USAGE_SECTIONS[focus]), { align: "start" });
      onFocused?.();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focus, data, onFocused]);

  if (isUnsupported(usage.error)) {
    return <EmptyState title="本地服务还没有提供使用数据">更新 Skill Control 后可以查看 {agentName} 的会话、Tokens 和常用技能。</EmptyState>;
  }
  if (usage.status === "error" && !data) return <EmptyState tone="error" title="读取使用数据失败">{errorMessage(usage.error)}</EmptyState>;
  if (!data) return <Loading label="正在统计…" rows={5} />;

  if (!data.sessions && !data.tokens?.total && !data.topSkills.length && !isIndexing(data.status, data.index)) {
    return (
      <EmptyState title={`最近 ${DAYS} 天没有 ${agentName} 的使用数据`}>
        目前能统计 Codex、Claude Code、WorkBuddy、Hermes、OpenClaw 和 QClaw 的本地会话记录。
      </EmptyState>
    );
  }
  const series = fillSeries(data.series, DAYS, localDate(now || null) || data.series[data.series.length - 1]?.date || "");
  const hasTokens = Boolean(data.tokens?.total);
  const hasCost = data.series.some((point) => point.costUsd > 0);
  const shown: Metric = (metric === "tokens" && hasTokens) || (metric === "cost" && hasCost) ? metric : "sessions";
  const estimated = estimatedPart(data.costBasis);
  const labels: Record<Metric, string> = { sessions: "每天活跃的会话数", tokens: "每天的 Tokens", cost: "每天的预估费用" };

  return (
    <div className="agent-usage">
      <IndexProgress status={data.status} index={data.index} />
      <section id={USAGE_SECTIONS.totals} className="usage-block">
        <div className="usage-head">
          <SourceBadges sources={data.sources} />
          {hasTokens || hasCost ? (
            <Segmented
              label="图表指标"
              value={shown}
              onChange={setMetric}
              items={[
                { id: "sessions" as const, label: "会话" },
                ...(hasTokens ? [{ id: "tokens" as const, label: "Tokens" }] : []),
                ...(hasCost ? [{ id: "cost" as const, label: "费用" }] : []),
              ]}
            />
          ) : null}
        </div>
        <div className="ustats">
          <div title={SESSIONS_HINT}>
            <b>{data.sessions.toLocaleString("zh-CN")}</b>
            <span>个会话 · {DAYS} 天</span>
          </div>
          <div>
            <b>{data.activeDays}</b>
            <span>天在用</span>
          </div>
          <div>
            <b>{data.tokens ? formatCompact(data.tokens.total) : "—"}</b>
            <span>Tokens</span>
          </div>
          {data.credits !== null ? (
            <div>
              <b>{formatCompact(data.credits)}</b>
              <span>额度</span>
            </div>
          ) : (
            <div className="ustat-cost" title={COST_HINT}>
              <b>{formatCost(data.costUsd)}</b>
              <span>
                {data.costUsd === null ? "费用未记录" : "预估费用"}
                <InfoIcon className="info-dot" aria-label={COST_HINT} />
              </span>
              {estimated ? <small>{estimated}</small> : null}
              {data.reportedCostUsd !== null ? <small>产品自报 {formatCost(data.reportedCostUsd)}</small> : null}
            </div>
          )}
        </div>
        {data.sessions || hasTokens ? (
          <AreaChart
            label={`${agentName} 最近 ${DAYS} 天${labels[shown]}`}
            unit={shown === "sessions" ? "个活跃会话" : shown === "tokens" ? "Tokens" : "美元（预估）"}
            format={shown === "cost" ? formatCost : undefined}
            points={series.map((point) => ({
              label: dayLabel(point.date),
              value: shown === "sessions" ? point.sessions : shown === "tokens" ? point.tokens : point.costUsd,
            }))}
          />
        ) : (
          <p className="muted small">最近 {DAYS} 天没有会话记录。</p>
        )}
      </section>
      <div className="usage-columns">
        <section id={USAGE_SECTIONS.skills} className="usage-block">
          <h3>常用技能</h3>
          <SkillRanking usage={data} />
        </section>
        <section id={USAGE_SECTIONS.models} className="usage-block">
          <h3>主要模型</h3>
          <ModelBreakdown usage={data} />
        </section>
      </div>
      <section id={USAGE_SECTIONS.projects} className="usage-block">
        <h3>常去的项目</h3>
        <ProjectBreakdown usage={data} agentName={agentName} />
      </section>
    </div>
  );
}
