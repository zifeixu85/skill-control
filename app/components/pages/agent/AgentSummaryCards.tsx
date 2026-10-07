"use client";

import type { ReactNode } from "react";
import { isUnsupported } from "../../../hooks/useResource";
import { COST_HINT, formatCost } from "../../../lib/cost";
import { formatCompact } from "../../../lib/format";
import { projectLabel } from "../../../lib/projects";
import { SESSIONS_HINT } from "../../../lib/usage";
import { useData } from "../../providers/DataProvider";
import { useAgentUsage } from "./AgentUsage";

/** Same window as the page header and the 概览 cards. */
const SUMMARY_DAYS = 30;
import type { UsageSection } from "./AgentUsageSections";

function Card({ title, section, onOpen, children }: { title: string; section: UsageSection; onOpen: (section: UsageSection) => void; children: ReactNode }) {
  return (
    <section className="summary-card">
      <header>
        <h3>{title}</h3>
        <button type="button" className="link-btn" onClick={() => onOpen(section)}>
          查看详情
        </button>
      </header>
      {children}
    </section>
  );
}

function TopList({ rows, empty }: { rows: { key: string; name: string; value: string; title?: string }[]; empty: string }) {
  if (!rows.length) return <p className="muted small">{empty}</p>;
  return (
    <ol className="summary-list">
      {rows.map((row) => (
        <li key={row.key}>
          <span className="nm" title={row.title || row.name}>
            {row.name}
          </span>
          <span className="v">{row.value}</span>
        </li>
      ))}
    </ol>
  );
}

/** The top of an Agent's 概览: usage, top skills, models and projects, each linking to 使用数据. */
export function AgentSummaryCards({ agentId, onOpen }: { agentId: string; onOpen: (section: UsageSection) => void }) {
  const usage = useAgentUsage(agentId, SUMMARY_DAYS);
  const { views } = useData();
  if (isUnsupported(usage.error) || (usage.status === "error" && !usage.data)) return null;
  const data = usage.data;
  if (!data) {
    return (
      <div className="summary-cards pending" aria-busy="true">
        <p className="muted small">正在统计使用数据…</p>
      </div>
    );
  }
  const titles = new Map(views.map((view) => [view.techName.toLowerCase(), view.title]));
  return (
    <div className="summary-cards">
      <Card title={`使用 · 近 ${SUMMARY_DAYS} 天`} section="totals" onOpen={onOpen}>
        <dl className="summary-stats" aria-label={`近 ${SUMMARY_DAYS} 天的使用`}>
          <div title={SESSIONS_HINT}>
            <dt>会话</dt>
            <dd>{data.sessions.toLocaleString("zh-CN")}</dd>
          </div>
          <div>
            <dt>天在用</dt>
            <dd>{data.activeDays}</dd>
          </div>
          <div>
            <dt>Tokens</dt>
            <dd>{data.tokens ? formatCompact(data.tokens.total) : "—"}</dd>
          </div>
          <div title={COST_HINT}>
            <dt>{data.credits !== null ? "额度" : "预估费用"}</dt>
            <dd>{data.credits !== null ? formatCompact(data.credits) : formatCost(data.costUsd)}</dd>
          </div>
        </dl>
      </Card>
      <Card title="常用技能" section="skills" onOpen={onOpen}>
        <TopList
          empty="还没有技能使用记录"
          rows={data.topSkills.slice(0, 3).map((skill) => ({
            key: skill.name,
            name: titles.get((skill.name.split(":").pop() || skill.name).toLowerCase()) || skill.name,
            value: `${skill.count} 次`,
            title: skill.name,
          }))}
        />
      </Card>
      <Card title="主要模型" section="models" onOpen={onOpen}>
        <TopList
          empty="会话记录里没有模型信息"
          rows={data.byModel.slice(0, 3).map((row) => ({
            key: `${row.model}:${row.basis}`,
            name: row.name,
            value: row.basis === "unpriced" ? "未定价" : formatCost(row.costUsd),
            title: row.model,
          }))}
        />
      </Card>
      <Card title="常去项目" section="projects" onOpen={onOpen}>
        <TopList
          empty="没有项目记录"
          rows={data.topProjects.slice(0, 3).map((project) => ({
            key: project.name ?? "\u0000unnamed",
            name: projectLabel(project.name),
            value: formatCost(project.costUsd),
          }))}
        />
      </Card>
    </div>
  );
}
