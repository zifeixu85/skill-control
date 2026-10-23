"use client";

import { useId } from "react";
import { usePageMemory } from "../../../hooks/usePageMemory";
import { usePersistent } from "../../../hooks/usePersistent";
import { isUnsupported, useResource } from "../../../hooks/useResource";
import { api } from "../../../lib/api";
import { formatRate } from "../../../lib/cache";
import { COST_HINT, formatCost } from "../../../lib/cost";
import { formatCompact } from "../../../lib/format";
import { persistentStore } from "../../../lib/storage";
import { HOME_WINDOWS, TOTALS_LABELS, totalsFor, type TotalsWindow, type TotalsWindowId } from "../../../lib/totals";
import type { UsageWindow } from "../../../lib/usage-window";
import { useData } from "../../providers/DataProvider";
import { AgentAvatar } from "../../ui/Avatar";
import { Segmented } from "../../ui/basics";
import { InfoPopover } from "../../ui/InfoPopover";

export const TOTALS_KEY = "usage:totals";
export const loadTotals = () => api.usageTotals();

/** Tokens lead (they are counted); cost is an estimate, so it is the secondary figure unless chosen. */
export type TotalsMetric = "tokens" | "cost";
export const totalsMetricStore = persistentStore<TotalsMetric>("totals-metric", "tokens", (value) => value === "tokens" || value === "cost");
const METRICS: { id: TotalsMetric; label: string }[] = [
  { id: "tokens", label: "Tokens" },
  { id: "cost", label: "预估费用" },
];

const tokensText = (value: number) => `${formatCompact(value)} tokens`;

/** The definition, behind a small ⓘ. */
export function CacheHint({ label = "缓存命中率是什么" }: { label?: string }) {
  return (
    <InfoPopover label={label}>
      <b className="info-pop-title">缓存命中率</b>
      <span>缓存读取 ÷（未缓存输入 + 缓存读取 + 缓存写入）</span>
      <small>即输入 tokens 里由缓存提供的比例。越高越省钱、越快。</small>
    </InfoPopover>
  );
}

/** Each Agent's share of the window, by the chosen metric. */
function Breakdown({ window, metric }: { window: TotalsWindow; metric: TotalsMetric }) {
  const { agentName } = useData();
  const byCost = metric === "cost" && window.byAgent.some((agent) => (agent.costUsd ?? 0) > 0);
  const value = (agent: TotalsWindow["byAgent"][number]) => (byCost ? agent.costUsd ?? 0 : agent.tokens);
  const max = Math.max(1, ...window.byAgent.map(value));
  if (!window.byAgent.length) return <p className="muted small">这段时间没有按 Agent 的记录。</p>;
  return (
    <ul className="totals-breakdown" aria-label={`${window.label}按 Agent 的构成`}>
      {window.byAgent.map((agent) => (
        <li key={agent.agentId}>
          <span className="tb-name">
            <AgentAvatar id={agent.agentId} size="xs" />
            <span className="clamp-1">{agentName(agent.agentId)}</span>
          </span>
          <span className="tb-bar" aria-hidden="true">
            <i style={{ transform: `scaleX(${value(agent) / max})` }} />
          </span>
          <span className={`num ${byCost ? "" : "lead"}`}>{formatCompact(agent.tokens)}</span>
          <span className={`num ${byCost ? "lead" : ""}`} title={COST_HINT}>
            {formatCost(agent.costUsd)}
          </span>
          <span className="num" title={`缓存命中率 ${formatRate(agent.cacheHitRate)}`}>
            {formatRate(agent.cacheHitRate)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function MetricToggle() {
  const [metric, setMetric] = usePersistent(totalsMetricStore);
  return <Segmented label="汇总显示" value={metric} onChange={setMetric} items={METRICS} />;
}

/** 首页: 今天 / 近 7 天 / 近 30 天 / 全部 — tokens first (or cost, remembered); a cell opens its breakdown. */
export function TotalsStrip() {
  const totals = useResource(TOTALS_KEY, loadTotals);
  const [metric] = usePersistent(totalsMetricStore);
  const [open, setOpen] = usePageMemory<string | null>("home:totals-open", null);
  const panelId = useId();
  if (isUnsupported(totals.error) || (totals.status === "error" && !totals.data)) return null;
  const windows = HOME_WINDOWS.map((id) => totalsFor(totals.data, id));
  const shown = open ? totalsFor(totals.data, open as TotalsWindowId) : null;
  return (
    <section className="totals" aria-label="全部 Agent 的用量汇总">
      <div className="totals-bar">
        <span className="totals-caption">
          全部 Agent 合计
          <CacheHint />
        </span>
        <MetricToggle />
      </div>
      <div className="totals-row">
        {HOME_WINDOWS.map((id, index) => {
          const window = windows[index];
          const label = window?.label || TOTALS_LABELS[id];
          const lead = window ? (metric === "cost" ? formatCost(window.costUsd) : formatCompact(window.tokens.total)) : "—";
          const second = window ? (metric === "cost" ? tokensText(window.tokens.total) : `预估 ${formatCost(window.costUsd)}`) : totals.data ? "没有数据" : "正在统计…";
          return (
            <button
              key={id}
              type="button"
              className={`totals-cell ${open === id ? "on" : ""}`}
              aria-expanded={open === id}
              aria-controls={panelId}
              disabled={!window}
              onClick={() => setOpen(open === id ? null : id)}
            >
              <span className="totals-label">{label}</span>
              <b title={metric === "cost" ? COST_HINT : undefined}>
                {lead}
                {window && metric === "tokens" ? <small> tokens</small> : null}
              </b>
              <span className="totals-sub">{second}</span>
              {window && window.cacheHitRate !== null ? <span className="totals-sub totals-cache">缓存命中 {formatRate(window.cacheHitRate)}</span> : null}
            </button>
          );
        })}
      </div>
      {shown ? (
        <div className="totals-panel" id={panelId}>
          <Breakdown window={shown} metric={metric} />
        </div>
      ) : null}
    </section>
  );
}

/** 数据: the selected window for all Agents combined. */
export function TotalsCard({ window: selected }: { window: UsageWindow }) {
  const totals = useResource(TOTALS_KEY, loadTotals);
  const [metric] = usePersistent(totalsMetricStore);
  if (isUnsupported(totals.error) || (totals.status === "error" && !totals.data)) return null;
  const window = totalsFor(totals.data, selected);
  if (!totals.data) return <div className="totals-card loading" aria-busy="true" />;
  if (!window) return null;
  const { tokens } = window;
  const tokenFigure = (
    <div key="tokens">
      <b>{formatCompact(tokens.total)}</b>
      <span>Tokens</span>
    </div>
  );
  const costFigure = (
    <div key="cost">
      <b title={COST_HINT}>{formatCost(window.costUsd)}</b>
      <span>预估费用</span>
    </div>
  );
  return (
    <section className="totals-card" aria-label={`${window.label}全部 Agent 合计`}>
      <div className="totals-main">
        <div className="totals-bar">
          <span className="totals-label">{window.label} · 全部 Agent 合计</span>
          <MetricToggle />
        </div>
        <div className={`totals-figures ${metric}`}>
          {metric === "cost" ? [costFigure, tokenFigure] : [tokenFigure, costFigure]}
          <div>
            <b>{formatRate(window.cacheHitRate)}</b>
            <span className="with-hint">
              缓存命中
              <CacheHint />
            </span>
          </div>
          <div>
            <b>{window.sessions.toLocaleString("zh-CN")}</b>
            <span>个会话</span>
          </div>
          <div>
            <b>{window.activeDays}</b>
            <span>天在用</span>
          </div>
        </div>
        <p className="token-split">
          输入 {formatCompact(tokens.input)} · 输出 {formatCompact(tokens.output)} · 缓存读取 {formatCompact(tokens.cacheRead)} · 缓存写入 {formatCompact(tokens.cacheWrite)}
        </p>
      </div>
      <Breakdown window={window} metric={metric} />
    </section>
  );
}
