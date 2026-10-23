"use client";

import { useId } from "react";
import { usePageMemory } from "../../../hooks/usePageMemory";
import { isUnsupported, useResource } from "../../../hooks/useResource";
import { api } from "../../../lib/api";
import { COST_HINT, formatCost } from "../../../lib/cost";
import { formatCompact } from "../../../lib/format";
import { HOME_WINDOWS, TOTALS_LABELS, totalsFor, type TotalsWindow, type TotalsWindowId } from "../../../lib/totals";
import type { UsageWindow } from "../../../lib/usage-window";
import { useData } from "../../providers/DataProvider";
import { AgentAvatar } from "../../ui/Avatar";

export const TOTALS_KEY = "usage:totals";
export const loadTotals = () => api.usageTotals();

/** Each Agent's share of the window's cost (or tokens when nothing is priced). */
function Breakdown({ window }: { window: TotalsWindow }) {
  const { agentName } = useData();
  const byCost = window.byAgent.some((agent) => (agent.costUsd ?? 0) > 0);
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
          <span className="num">{formatCompact(agent.tokens)}</span>
          <span className="num">{formatCost(agent.costUsd)}</span>
        </li>
      ))}
    </ul>
  );
}

/** 首页: 今天 / 近 7 天 / 近 30 天 / 全部 — tokens and estimated cost; a cell opens its breakdown. */
export function TotalsStrip() {
  const totals = useResource(TOTALS_KEY, loadTotals);
  const [open, setOpen] = usePageMemory<string | null>("home:totals-open", null);
  const panelId = useId();
  if (isUnsupported(totals.error) || (totals.status === "error" && !totals.data)) return null;
  const windows = HOME_WINDOWS.map((id) => totalsFor(totals.data, id));
  const shown = open ? totalsFor(totals.data, open as TotalsWindowId) : null;
  return (
    <section className="totals" aria-label="全部 Agent 的用量汇总">
      <div className="totals-row">
        {HOME_WINDOWS.map((id, index) => {
          const window = windows[index];
          const label = window?.label || TOTALS_LABELS[id];
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
              <b title={COST_HINT}>{window ? formatCost(window.costUsd) : "—"}</b>
              <span className="totals-sub">{window ? `${formatCompact(window.tokens.total)} tokens` : totals.data ? "没有数据" : "正在统计…"}</span>
            </button>
          );
        })}
      </div>
      {shown ? (
        <div className="totals-panel" id={panelId}>
          <Breakdown window={shown} />
        </div>
      ) : null}
    </section>
  );
}

/** 数据: the selected window for all Agents combined. */
export function TotalsCard({ window: selected }: { window: UsageWindow }) {
  const totals = useResource(TOTALS_KEY, loadTotals);
  if (isUnsupported(totals.error) || (totals.status === "error" && !totals.data)) return null;
  const window = totalsFor(totals.data, selected);
  if (!totals.data) return <div className="totals-card loading" aria-busy="true" />;
  if (!window) return null;
  const { tokens } = window;
  return (
    <section className="totals-card" aria-label={`${window.label}全部 Agent 合计`}>
      <div className="totals-main">
        <span className="totals-label">{window.label} · 全部 Agent 合计</span>
        <div className="totals-figures">
          <div>
            <b title={COST_HINT}>{formatCost(window.costUsd)}</b>
            <span>预估费用</span>
          </div>
          <div>
            <b>{formatCompact(tokens.total)}</b>
            <span>Tokens</span>
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
      <Breakdown window={window} />
    </section>
  );
}
