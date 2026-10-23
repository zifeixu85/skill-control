"use client";

import { formatRate, rateTone } from "../../../lib/cache";
import { CacheHint } from "../usage/TotalsStrip";
import { basisChip, BASIS_HINTS, BASIS_LABELS, COST_HINT, formatCost, longShareLabel, priceTarget, type ModelRow } from "../../../lib/cost";
import { formatCompact } from "../../../lib/format";
import { confidenceLabel, type AgentUsage } from "../../../lib/usage";
import { useData } from "../../providers/DataProvider";
import { useNav } from "../../providers/NavProvider";
import { ItemText } from "../../ui/Item";
import { ProjectTable } from "../usage/ProjectTable";

/** Section ids the 概览 cards scroll to. */
export const USAGE_SECTIONS = {
  totals: "agent-usage-totals",
  skills: "agent-usage-skills",
  models: "agent-usage-models",
  projects: "agent-usage-projects",
} as const;
export type UsageSection = keyof typeof USAGE_SECTIONS;

export function SkillRanking({ usage, limit = 12 }: { usage: AgentUsage; limit?: number }) {
  const { views } = useData();
  const { go } = useNav();
  const byName = new Map(views.map((view) => [view.techName.toLowerCase(), view]));
  const max = usage.topSkills[0]?.count || 1;
  if (!usage.topSkills.length) return <p className="muted small">还没有技能使用记录。</p>;
  return (
    <ol className="rank">
      {usage.topSkills.slice(0, limit).map((skill) => {
        const view = byName.get((skill.name.split(":").pop() || skill.name).toLowerCase());
        return (
          <li key={skill.name}>
            {view ? (
              <button type="button" className="link-btn nm" onClick={() => go("skills", { skillId: view.id })} title={skill.name}>
                {view.title}
              </button>
            ) : (
              <span className="nm" title={skill.name}>
                {skill.name}
              </span>
            )}
            <span className="bar" aria-hidden="true">
              <i style={{ width: `${Math.max(6, (skill.count / max) * 100)}%` }} />
            </span>
            <span className="v" title={confidenceLabel(skill.confidence)}>
              {skill.count} 次
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function ModelLine({ row }: { row: ModelRow }) {
  const { go } = useNav();
  const chip = basisChip(row.basis);
  return (
    <tr className={row.basis === "unpriced" ? "warn-row" : ""}>
      <th scope="row" className="cell-main">
        <ItemText
          title={row.name}
          meta={row.name !== row.model ? row.model : null}
          mono
          desc={row.basis === "unpriced" ? <span className="danger-text">价格表里没有这个模型</span> : longShareLabel(row.longShare)}
        />
      </th>
      <td className="num">{formatCompact(row.tokens.total)}</td>
      <td className={`num rate ${rateTone(row.cacheHitRate)}`}>{formatRate(row.cacheHitRate)}</td>
      <td className="num cost">{row.basis === "unpriced" ? "—" : formatCost(row.costUsd)}</td>
      <td className="cell-tags">
        <button
          type="button"
          className={`tag chip-btn ${chip.tone === "ok" ? "" : chip.tone}`}
          title={`${BASIS_HINTS[row.basis]} · 在价格表中查看`}
          onClick={() => go("pricing", { priceRow: priceTarget(row) })}
        >
          {BASIS_LABELS[row.basis]}
        </button>
      </td>
    </tr>
  );
}

export function ModelBreakdown({ usage }: { usage: AgentUsage }) {
  if (!usage.byModel.length) return <p className="muted small">会话记录里没有模型信息。</p>;
  return (
    <div className="matrix model-table">
      <table>
        <caption className="sr-only">各模型的用量和预估费用</caption>
        <thead>
          <tr>
            <th scope="col">模型</th>
            <th scope="col" className="num">Tokens</th>
            <th scope="col" className="num">
              <span className="with-hint">
                缓存命中
                <CacheHint />
              </span>
            </th>
            <th scope="col" className="num" title={COST_HINT}>
              预估费用
            </th>
            <th scope="col" className="th-tags">依据</th>
          </tr>
        </thead>
        <tbody>
          {usage.byModel.map((row) => (
            <ModelLine key={`${row.model}:${row.basis}`} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ProjectBreakdown({ usage, agentName }: { usage: AgentUsage; agentName: string }) {
  if (!usage.topProjects.length) return <p className="muted small">没有项目记录。</p>;
  return (
    <ProjectTable
      projects={usage.topProjects}
      other={usage.otherProjects}
      totalCost={usage.costUsd}
      caption={`${agentName} 各项目的会话、Tokens 和预估费用`}
    />
  );
}
