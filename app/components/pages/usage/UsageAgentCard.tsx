"use client";

import { usePageMemory } from "../../../hooks/usePageMemory";
import { COST_HINT, formatCost } from "../../../lib/cost";
import { formatCompact } from "../../../lib/format";
import { CONFIDENCE_HINTS, confidenceLabel, SESSIONS_HINT, type UsageAgent, type UsageSource } from "../../../lib/usage";
import { chartPoints, perPeriod, PERIOD_NAMES, sessionsMetricLabel, windowLabel, type ChartPoint, type Period } from "../../../lib/usage-window";
import { InfoIcon } from "../../icons";
import { AreaChart } from "../../charts/AreaChart";
import { useData } from "../../providers/DataProvider";
import { AgentAvatar } from "../../ui/Avatar";
import { Segmented } from "../../ui/basics";
import { InfoPopover } from "../../ui/InfoPopover";

export type Metric = "sessions" | "tokens" | "cost";

export function metricText(metric: Metric, period: Period): { label: string; unit: string } {
  if (metric === "sessions") return { label: sessionsMetricLabel(period), unit: period === "day" ? "个活跃会话" : "个会话" };
  if (metric === "tokens") return { label: `${perPeriod(period)}的 Tokens`, unit: "Tokens" };
  return { label: `${perPeriod(period)}的预估费用`, unit: "美元（预估）" };
}

export const metricValue = (point: ChartPoint, metric: Metric) =>
  metric === "sessions" ? point.sessions : metric === "tokens" ? point.tokens : point.costUsd;

/** 预估费用, and for Hermes / OpenClaw the figure the product records itself. */
function CostStat({ usage }: { usage: UsageAgent }) {
  return (
    <div className="ustat-cost" title={COST_HINT}>
      <b>{formatCost(usage.costUsd)}</b>
      <span>
        {usage.costUsd === null ? "费用未记录" : "预估费用"}
        <InfoIcon className="info-dot" aria-label={COST_HINT} />
      </span>
      {usage.reportedCostUsd !== null ? <small>产品自报 {formatCost(usage.reportedCostUsd)}</small> : null}
    </div>
  );
}

export const dayLabel = (date: string) => `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;

/** Where the numbers come from and how sure they are — behind a small ⓘ next to the name. */
export function SourceInfo({ sources, name }: { sources: UsageSource[]; name: string }) {
  if (!sources.length) return null;
  return (
    <InfoPopover label={`${name} 的数据来源`}>
      <b className="info-pop-title">数据来源</b>
      <ul className="source-list">
        {sources.map((source) => (
          <li key={`${source.id}-${source.label}`}>
            <span>{source.label || source.id}</span>
            <span className={`conf ${source.confidence || "unknown"}`} title={source.confidence ? CONFIDENCE_HINTS[source.confidence] : undefined}>
              {confidenceLabel(source.confidence)}
            </span>
          </li>
        ))}
      </ul>
      <small>精确 = 从会话记录逐条统计；推断 = 从读取 SKILL.md 的动作推断；产品自报 = 产品自己记录的数字。</small>
    </InfoPopover>
  );
}

export function UsageAgentCard({ usage, days, endDate }: { usage: UsageAgent; days: number | null; endDate: string }) {
  const { agentName } = useData();
  const hasTokens = Boolean(usage.tokens?.total) || usage.series.some((point) => point.tokens > 0);
  const hasCost = usage.series.some((point) => point.costUsd > 0);
  const [metric, setMetric] = usePageMemory<Metric>(`usage:metric:${usage.agentId}`, "sessions");
  const { period, points } = chartPoints(usage.series, days, endDate);
  const shown: Metric = (metric === "tokens" && hasTokens) || (metric === "cost" && hasCost) ? metric : "sessions";
  const name = agentName(usage.agentId);
  const tokens = usage.tokens;
  const text = metricText(shown, period);
  return (
    <article className="ucard">
      <header className="ucard-head">
        <AgentAvatar id={usage.agentId} size="md" />
        <div className="ucard-title">
          <h3>
            {name}
            <SourceInfo sources={usage.sources} name={name} />
          </h3>
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
      {points.length ? (
        <AreaChart
          label={`${name} · ${windowLabel(days)} · ${text.label}`}
          unit={text.unit}
          periodLabel={PERIOD_NAMES[period]}
          format={shown === "cost" ? formatCost : undefined}
          points={points.map((point) => ({ label: point.label, value: metricValue(point, shown) }))}
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
