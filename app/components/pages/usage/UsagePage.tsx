"use client";

import { useState } from "react";
import { useNow } from "../../../hooks/useNow";
import { usePolling } from "../../../hooks/usePolling";
import { isUnsupported, useResource } from "../../../hooks/useResource";
import { useScrollMemory } from "../../../hooks/useScrollMemory";
import { api, errorMessage } from "../../../lib/api";
import { formatCompact, formatRelative } from "../../../lib/format";
import { CONFIDENCE_HINTS, confidenceLabel, isIndexing, localDate, type TopSkill, type UsageSummary } from "../../../lib/usage";
import { useData } from "../../providers/DataProvider";
import { useNav } from "../../providers/NavProvider";
import { AgentAvatar } from "../../ui/Avatar";
import { EmptyState, Loading, SectionHeading, Segmented, TopBar } from "../../ui/basics";
import { IndexProgress } from "./IndexProgress";
import { UsageAgentCard } from "./UsageAgentCard";

type Days = "7" | "30" | "90";

function TopSkillsTable({ skills, agentIds }: { skills: TopSkill[]; agentIds: string[] }) {
  const { views, agentName } = useData();
  const { go } = useNav();
  const byName = new Map(views.map((view) => [view.techName.toLowerCase(), view]));
  const max = skills[0]?.count || 1;
  return (
    <div className="matrix">
      <table>
        <caption className="sr-only">用得最多的技能</caption>
        <thead>
          <tr>
            <th scope="col">技能</th>
            {agentIds.map((agentId) => (
              <th scope="col" key={agentId}>
                <span className="th-agent">
                  <AgentAvatar id={agentId} size="xs" />
                  {agentName(agentId)}
                </span>
              </th>
            ))}
            <th scope="col">合计</th>
          </tr>
        </thead>
        <tbody>
          {skills.slice(0, 30).map((skill) => {
            const shortName = skill.name.split(":").pop() || skill.name;
            const view = byName.get(skill.name.toLowerCase()) || byName.get(shortName.toLowerCase());
            return (
              <tr key={skill.name}>
                <th scope="row">
                  {view ? (
                    <button type="button" className="link-btn" onClick={() => go("skills", { skillId: view.id })}>
                      {view.title}
                    </button>
                  ) : (
                    <span>{skill.name}</span>
                  )}
                  {view && view.title !== skill.name ? <small className="tech"> {skill.name}</small> : null}
                </th>
                {agentIds.map((agentId) => {
                  const confidence = skill.confidenceByAgent[agentId];
                  return (
                    <td key={agentId} className="num">
                      {skill.byAgent[agentId] ? (
                        <span title={confidence ? `${confidenceLabel(confidence)}：${CONFIDENCE_HINTS[confidence] || ""}` : undefined}>
                          {skill.byAgent[agentId]}
                          {confidence && confidence !== "exact" ? <sup className={`conf-dot ${confidence}`}>{confidenceLabel(confidence)}</sup> : null}
                        </span>
                      ) : (
                        <span className="none">—</span>
                      )}
                    </td>
                  );
                })}
                <td className="num total">
                  <span className="mini-bar" aria-hidden="true">
                    <i style={{ width: `${Math.max(4, (skill.count / max) * 100)}%` }} />
                  </span>
                  {skill.count}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Real but coarse: session-file activity the scan already collects. */
function ActivityFallback() {
  const { scan, agentName } = useData();
  const now = useNow();
  const rows = (scan.data?.agentActivity?.agents || []).filter((entry) => entry.files30d || entry.tokens30d);
  if (!rows.length) return null;
  return (
    <>
      <SectionHeading title="会话活跃度" note="按会话文件的修改时间统计，只看数量，不读内容" />
      <div className="matrix">
        <table>
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">近 30 天会话</th>
              <th scope="col">在用天数</th>
              <th scope="col">Tokens</th>
              <th scope="col">最近一次</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((entry) => (
              <tr key={entry.agentId}>
                <th scope="row">
                  <span className="th-agent">
                    <AgentAvatar id={entry.agentId} size="xs" />
                    {agentName(entry.agentId)}
                  </span>
                </th>
                <td className="num">{entry.basis === "tokens" ? "—" : entry.files30d}</td>
                <td className="num">{entry.activeDays30d}</td>
                <td className="num">{entry.tokens30d ? formatCompact(entry.tokens30d) : "—"}</td>
                <td>{now ? formatRelative(entry.lastActiveAt, now) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function SummaryView({ summary, days }: { summary: UsageSummary; days: number }) {
  const now = useNow();
  const endDate = localDate(summary.generatedAt) || localDate(now || null);
  const { primary } = useData();
  const agents = summary.agents
    .filter((agent) => agent.sessions || agent.tokens?.total || agent.credits)
    .sort(
      (left, right) =>
        Number(primary.includes(right.agentId)) - Number(primary.includes(left.agentId)) ||
        (primary.indexOf(left.agentId) - primary.indexOf(right.agentId)) ||
        right.sessions - left.sessions,
    );
  const skillAgents = [...new Set(summary.topSkills.flatMap((skill) => Object.keys(skill.byAgent)))];
  return (
    <>
      {agents.length ? (
        <div className="ugrid">
          {agents.map((agent) => (
            <UsageAgentCard key={agent.agentId} usage={agent} days={days} endDate={endDate} />
          ))}
        </div>
      ) : (
        <EmptyState title={`最近 ${days} 天没有会话记录`}>
          {isIndexing(summary.status, summary.index) ? "统计完成后会显示在这里。" : null}
        </EmptyState>
      )}
      <SectionHeading title="用得最多的技能" note={`最近 ${days} 天 · 会话里实际调用或读取的次数`} />
      {summary.topSkills.length ? (
        <TopSkillsTable skills={summary.topSkills} agentIds={skillAgents} />
      ) : (
        <p className="muted small">还没有技能使用记录。</p>
      )}
      <p className="footnote">
        可信度：<b>精确</b> = 从会话记录逐条统计；<b>推断</b> = 从会话里读取 SKILL.md 的动作推断；<b>产品自报</b> = 产品自己记录的数字。
      </p>
    </>
  );
}

export function UsagePage() {
  const [days, setDays] = useState<Days>("30");
  const scrollRef = useScrollMemory<HTMLDivElement>("usage");
  const now = useNow();
  const summary = useResource(`usage:summary:${days}`, () => api.usageSummary(Number(days)));
  const data = summary.data;
  const indexing = Boolean(data && isIndexing(data.status, data.index));
  usePolling(indexing, () => void summary.reload(), 3_000);
  const unsupported = isUnsupported(summary.error);
  const updatedAt = data?.index?.updatedAt || data?.status?.updatedAt;

  return (
    <section className="page" aria-labelledby="page-title">
      <TopBar
        title={<span id="page-title">数据</span>}
        sub={
          updatedAt && now
            ? `${formatRelative(updatedAt, now)}更新 · 只在本机统计，不读对话内容`
            : "各 Agent 的会话、Tokens 和技能使用情况，只在本机统计"
        }
      >
        <Segmented
          label="时间范围"
          value={days}
          onChange={setDays}
          items={[
            { id: "7", label: "7 天" },
            { id: "30", label: "30 天" },
            { id: "90", label: "90 天" },
          ]}
        />
      </TopBar>
      <div className="scroll" ref={scrollRef}>
        {data ? <IndexProgress status={data.status} index={data.index} /> : null}
        {unsupported ? (
          <EmptyState title="本地服务还没有提供使用数据">
            更新 Skill Control 后会显示每个 Agent 的会话、Tokens 和技能调用次数。下面是扫描时顺带统计的会话活跃度。
          </EmptyState>
        ) : summary.status === "error" && !data ? (
          <EmptyState
            tone="error"
            title="读取使用数据失败"
            action={
              <button type="button" className="btn" onClick={() => void summary.reload()}>
                再试一次
              </button>
            }
          >
            {errorMessage(summary.error)}
          </EmptyState>
        ) : !data ? (
          <Loading label="正在统计使用数据…" rows={6} />
        ) : (
          <SummaryView summary={data} days={Number(days)} />
        )}
        {unsupported || (summary.status === "error" && !data) ? <ActivityFallback /> : null}
      </div>
    </section>
  );
}
