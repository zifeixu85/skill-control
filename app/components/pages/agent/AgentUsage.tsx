"use client";

import { useState } from "react";
import { useNow } from "../../../hooks/useNow";
import { usePolling } from "../../../hooks/usePolling";
import { isUnsupported, useResource } from "../../../hooks/useResource";
import { api, errorMessage } from "../../../lib/api";
import { formatCompact, formatUsd } from "../../../lib/format";
import { confidenceLabel, fillSeries, isIndexing, localDate } from "../../../lib/usage";
import { AreaChart } from "../../charts/AreaChart";
import { useData } from "../../providers/DataProvider";
import { useNav } from "../../providers/NavProvider";
import { EmptyState, Loading, Segmented } from "../../ui/basics";
import { IndexProgress } from "../usage/IndexProgress";
import { dayLabel, SourceBadges } from "../usage/UsageAgentCard";

const DAYS = 90;

export function AgentUsage({ agentId, agentName }: { agentId: string; agentName: string }) {
  const usage = useResource(`usage:agent:${agentId}:${DAYS}`, () => api.usageAgent(agentId, DAYS));
  const { views } = useData();
  const { go } = useNav();
  const now = useNow();
  const [metric, setMetric] = useState<"sessions" | "tokens">("sessions");
  const data = usage.data;
  usePolling(Boolean(data && isIndexing(data.status, data.index)), () => void usage.reload(), 3_000);

  if (isUnsupported(usage.error)) {
    return <EmptyState title="本地服务还没有提供使用数据">更新 Skill Control 后可以查看 {agentName} 的会话、Tokens 和常用技能。</EmptyState>;
  }
  if (usage.status === "error" && !data) return <EmptyState tone="error" title="读取使用数据失败">{errorMessage(usage.error)}</EmptyState>;
  if (!data) return <Loading label="正在统计…" rows={5} />;

  const byName = new Map(views.map((view) => [view.techName.toLowerCase(), view]));
  const series = fillSeries(data.series, DAYS, localDate(now || null) || data.series[data.series.length - 1]?.date || "");
  const hasTokens = Boolean(data.tokens?.total);
  const shown = hasTokens ? metric : "sessions";
  const max = data.topSkills[0]?.count || 1;

  return (
    <div className="agent-usage">
      <IndexProgress status={data.status} index={data.index} />
      <div className="usage-head">
        <SourceBadges sources={data.sources} />
        {hasTokens ? (
          <Segmented
            label="图表指标"
            value={shown}
            onChange={setMetric}
            items={[
              { id: "sessions", label: "会话" },
              { id: "tokens", label: "Tokens" },
            ]}
          />
        ) : null}
      </div>
      <div className="ustats">
        <div>
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
        <div>
          <b>{data.credits !== null ? formatCompact(data.credits) : formatUsd(data.costUsd)}</b>
          <span>{data.credits !== null ? "额度" : data.costUsd === null ? "费用未记录" : "费用"}</span>
        </div>
      </div>
      {data.sessions || hasTokens ? (
        <AreaChart
          label={`${agentName} 最近 ${DAYS} 天每天的${shown === "sessions" ? "会话数" : "Tokens"}`}
          unit={shown === "sessions" ? "个会话" : "Tokens"}
          points={series.map((point) => ({ label: dayLabel(point.date), value: shown === "sessions" ? point.sessions : point.tokens }))}
        />
      ) : (
        <p className="muted small">最近 {DAYS} 天没有会话记录。</p>
      )}
      <div className="usage-columns">
        <section>
          <h3>常用技能</h3>
          {data.topSkills.length ? (
            <ol className="rank">
              {data.topSkills.slice(0, 12).map((skill) => {
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
          ) : (
            <p className="muted small">还没有技能使用记录。</p>
          )}
        </section>
        <section>
          <h3>常去的项目</h3>
          {data.topProjects.length ? (
            <ol className="rank">
              {data.topProjects.slice(0, 12).map((project) => (
                <li key={project.name}>
                  <span className="nm" title={project.name}>
                    {project.name}
                  </span>
                  <span className="muted small">{formatCompact(project.tokens)} tokens</span>
                  <span className="v">{project.sessions} 个会话</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted small">没有项目记录。</p>
          )}
          <p className="footnote">项目只取工作目录的最后一段名称。</p>
        </section>
      </div>
    </div>
  );
}
