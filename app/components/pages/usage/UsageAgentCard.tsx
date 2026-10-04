"use client";

import { useState } from "react";
import { formatCompact, formatUsd } from "../../../lib/format";
import { CONFIDENCE_HINTS, confidenceLabel, fillSeries, type UsageAgent, type UsageSource } from "../../../lib/usage";
import { AreaChart } from "../../charts/AreaChart";
import { useData } from "../../providers/DataProvider";
import { AgentAvatar } from "../../ui/Avatar";
import { Segmented } from "../../ui/basics";

type Metric = "sessions" | "tokens";

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
  const [metric, setMetric] = useState<Metric>("sessions");
  const series = fillSeries(usage.series, days, endDate);
  const shown: Metric = hasTokens ? metric : "sessions";
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
        {hasTokens ? (
          <Segmented
            label={`${name} 图表指标`}
            value={shown}
            onChange={setMetric}
            items={[
              { id: "sessions", label: "会话" },
              { id: "tokens", label: "Tokens" },
            ]}
          />
        ) : null}
      </header>
      <div className="ustats">
        <div>
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
          <div>
            <b>{formatUsd(usage.costUsd)}</b>
            <span>{usage.costUsd === null ? "费用未记录" : "费用"}</span>
          </div>
        )}
      </div>
      {series.length ? (
        <AreaChart
          label={`${name} 最近 ${days} 天每天的${shown === "sessions" ? "会话数" : "Tokens"}`}
          unit={shown === "sessions" ? "个会话" : "Tokens"}
          points={series.map((point) => ({
            label: dayLabel(point.date),
            value: shown === "sessions" ? point.sessions : point.tokens,
          }))}
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
