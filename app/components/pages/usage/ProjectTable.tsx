"use client";

import { formatRate, rateTone } from "../../../lib/cache";
import { CacheHint } from "./TotalsStrip";
import { COST_HINT, formatCost } from "../../../lib/cost";
import { formatCompact } from "../../../lib/format";
import { PROJECT_NOTE, projectLabel, topModelNames, type OtherProjects, type ProjectRow } from "../../../lib/projects";
import { SESSIONS_HINT } from "../../../lib/usage";
import { useData } from "../../providers/DataProvider";
import { AgentAvatar } from "../../ui/Avatar";
import { ItemText } from "../../ui/Item";

function splitText(project: ProjectRow): string | undefined {
  const split = project.tokenSplit;
  if (!split) return undefined;
  return `输入 ${formatCompact(split.input)} · 输出 ${formatCompact(split.output)} · 缓存读 ${formatCompact(split.cacheRead)} · 缓存写 ${formatCompact(split.cacheWrite + split.cacheWrite1h)}`;
}

function Row({ project, showAgents }: { project: ProjectRow; showAgents: boolean }) {
  const { agentName } = useData();
  const models = project.topModels.map((model) => `${model.name} ${formatCost(model.costUsd)}`).join("\n");
  return (
    <tr className={project.name ? "" : "unnamed"}>
      <th scope="row" className="cell-main">
        <ItemText title={projectLabel(project.name)} desc={project.name ? null : "没有记录工作文件夹的会话"} />
      </th>
      {showAgents ? (
        <td className="cell-agents">
          <span className="avatar-row">
            {project.agents.map((agent) => (
              <span key={agent.agentId} title={`${agentName(agent.agentId)}：${formatCost(agent.costUsd)} · ${formatCompact(agent.tokens)} tokens`}>
                <AgentAvatar id={agent.agentId} size="xs" />
              </span>
            ))}
          </span>
        </td>
      ) : null}
      <td className="num" title={SESSIONS_HINT}>
        {project.sessions.toLocaleString("zh-CN")}
      </td>
      <td className="num" title={splitText(project)}>
        {formatCompact(project.tokens)}
      </td>
      <td className={`num rate ${rateTone(project.cacheHitRate)}`}>{formatRate(project.cacheHitRate)}</td>
      <td className="num cost" title={COST_HINT}>
        {formatCost(project.costUsd)}
      </td>
      <td className="models" title={models || undefined}>
        {project.topModels.length ? (
          <>
            {topModelNames(project)}
            {project.topModels.length > 2 ? <span className="muted"> +{project.topModels.length - 2}</span> : null}
          </>
        ) : (
          <span className="none">—</span>
        )}
      </td>
    </tr>
  );
}

/**
 * 项目成本: projects by estimated cost, the rest folded into "其余 N 个项目", and a total
 * that matches the Agent (or window) total.
 */
export function ProjectTable({
  projects,
  other,
  totalCost,
  showAgents = false,
  caption,
}: {
  projects: ProjectRow[];
  other: OtherProjects | null;
  totalCost: number | null;
  showAgents?: boolean;
  caption: string;
}) {
  const columns = showAgents ? 6 : 5;
  const tokens = projects.reduce((sum, project) => sum + project.tokens, 0) + (other?.tokens || 0);
  return (
    <>
      <div className="matrix model-table project-table">
        <table>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              <th scope="col">项目</th>
              {showAgents ? <th scope="col">Agents</th> : null}
              <th scope="col" className="num" title={SESSIONS_HINT}>
                会话
              </th>
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
              <th scope="col">主要模型</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => (
              <Row key={project.name ?? "\u0000unnamed"} project={project} showAgents={showAgents} />
            ))}
          </tbody>
          <tfoot>
            {other ? (
              <tr className="other">
                <th scope="row" colSpan={columns - 4}>
                  其余 {other.count} 个项目
                </th>
                <td className="num" />
                <td className="num">{formatCompact(other.tokens)}</td>
                <td className="num" />
                <td className="num cost">{formatCost(other.costUsd)}</td>
                <td />
              </tr>
            ) : null}
            <tr>
              <th scope="row" colSpan={columns - 4}>
                合计
              </th>
              {/* Sessions don't add up across projects (one session can work in several). */}
              <td className="num" />
              <td className="num">{formatCompact(tokens)}</td>
              <td className="num" />
              <td className="num cost" title={COST_HINT}>
                {formatCost(totalCost)}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="footnote">{PROJECT_NOTE}；同一个会话在它工作过的每个项目各计一次。</p>
    </>
  );
}
