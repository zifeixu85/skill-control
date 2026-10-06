"use client";

import { useState } from "react";
import { COST_HINT, estimatedPart, formatCost } from "../../../lib/cost";
import { formatCompact } from "../../../lib/format";
import { CONFIDENCE_HINTS, confidenceLabel, fillSeries, SESSIONS_HINT, type UsageAgent, type UsagePoint, type UsageSource } from "../../../lib/usage";
import { InfoIcon } from "../../icons";
import { AreaChart } from "../../charts/AreaChart";
import { useData } from "../../providers/DataProvider";
import { AgentAvatar } from "../../ui/Avatar";
import { Segmented } from "../../ui/basics";

type Metric = "sessions" | "tokens" | "cost";

const METRIC_UNITS: Record<Metric, string> = { sessions: "个活跃会话", tokens: "Tokens", cost: "美元（预估）" };
const METRIC_LABELS: Record<Metric, string> = { sessions: "每天活跃的会话数", tokens: "每天的 Tokens", cost: "每天的预估费用" };
const metricValue = (point: UsagePoint, metric: Metric) =>
  metric === "sessions" ? point.sessions : metric === "tokens" ? point.tokens : point.costUsd;

/** 预估费用 with what it's based on: the estimated part and, for Hermes / OpenClaw, the product's own figure. */
function CostStat({ usage }: { usage: UsageAgent }) {
  const estimated = estimatedPart(usage.costBasis);
  return (
    <div className="ustat-cost" title={COST_HINT}>
      <b>{formatCost(usage.costUsd)}</b>
      <span>
        {usage.costUsd === null ? "费用未记录" : "预估费用"}
        <InfoIcon className="info-dot" aria-label={COST_HINT} />
      </span>
      {estimated ? <small>{estimated}</small> : null}
      {usage.reportedCostUsd !== null ? <small>产品自报 {formatCost(usage.reportedCostUsd)}</small> : null}
    </div>
  );
}

export const dayLabel = (date: string) => `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;

export function SourceBadges({ sources }: { sources: UsageSource[] }) {
  if (!sources.length) return null;
  return (
    <span className="source-badges">
      {sources.map((source) => (
        <span
          key={`${source.id}-${source.label}`}
          className={`conf ${source.confidence || "unknown"}`}
          title={source.confidence ? CONFIDENCE_HINTS[source.confidence] : undefined}
        >
          {source.label || source.id} · {confidenceLabel(source.confidence)}
        </span>
      ))}
    </span>
  );
}

export function UsageAgentCard({ usage, days, endDate }: { usage: UsageAgent; days: number; endDate: string }) {
  const { agentName } = useData();
  const hasTokens = Boolean(usage.tokens?.total) || usage.series.some((point) => point.tokens > 0);
  const hasCost = usage.series.some((point) => point.costUsd > 0);
  const [metric, setMetric] = useState<Metric>("sessions");
  const series = fillSeries(usage.series, days, endDate);
  const shown: Metric = (metric === "tokens" && hasTokens) || (metric === "cost" && hasCost) ? metric : "sessions";
  const name = agentName(usage.agentId);
  const tokens = usage.tokens;
  return (
    <article className="ucard">
      <header className="ucard-head">
        <AgentAvatar id={usage.agentId} size="md" />
        <div className="ucard-title">
          <h3>{name}</h3>
          <SourceBadges sources={usage.sources} />
        </div>
        {hasTokens || hasCost ? (
          <Segmented
            label={`${name} 图表指标`}
            value={shown}
            onChange={setMetric}
            items={[
              { id: "sessions" as const, label: "会话" },
              ...(hasTokens ? [{ id: "tokens" as const, label: "Tokens" }] : []),
              ...(hasCost ? [{ id: "cost" as const, label: "费用" }] : []),
            ]}
          />
        ) : null}
      </header>
      <div className="ustats">
        <div title={SESSIONS_HINT}>
          <b>{usage.sessions.toLocaleString("zh-CN")}</b>
          <span>个会话</span>
        </div>
        <div>
          <b>{usage.activeDays}</b>
          <span>天在用</span>
        </div>
        <div>
          <b>{tokens ? formatCompact(tokens.total) : "—"}</b>
          <span>Tokens</span>
        </div>
        {usage.credits !== null ? (
          <div>
            <b>{formatCompact(usage.credits)}</b>
            <span>额度</span>
          </div>
        ) : (
          <CostStat usage={usage} />
        )}
      </div>
      {series.length ? (
        <AreaChart
          label={`${name} 最近 ${days} 天${METRIC_LABELS[shown]}`}
          unit={METRIC_UNITS[shown]}
          format={shown === "cost" ? formatCost : undefined}
          points={series.map((point) => ({ label: dayLabel(point.date), value: metricValue(point, shown) }))}
        />
      ) : (
        <p className="muted small">没有按天的数据。</p>
      )}
      {tokens && tokens.total ? (
        <p className="token-split">
          输入 {formatCompact(tokens.input)} · 输出 {formatCompact(tokens.output)} · 缓存读取 {formatCompact(tokens.cacheRead)} · 缓存写入{" "}
          {formatCompact(tokens.cacheWrite)}
        </p>
      ) : null}
    </article>
  );
}
