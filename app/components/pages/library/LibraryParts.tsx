"use client";

import {
  agentCounts,
  KIND_LABELS,
  STATE_LABELS,
  TIER_HINTS,
  TIER_LABELS,
  type LibraryAgent,
  type LibraryData,
  type LibraryEntry,
} from "../../../lib/library";
import { useData } from "../../providers/DataProvider";
import { useNav } from "../../providers/NavProvider";
import { AgentAvatar } from "../../ui/Avatar";

export function AgentStrip({ data, agents }: { data: LibraryData; agents: LibraryAgent[] }) {
  return (
    <div className="lib-agents">
      {agents.map((agent) => {
        const counts = agentCounts(data, agent.agentId);
        return (
          <article key={agent.agentId} className={`lib-agent ${agent.primary ? "primary" : ""}`}>
            <header>
              <AgentAvatar id={agent.agentId} size="md" />
              <div>
                <b>{agent.name}</b>
                <span className="tier" title={TIER_HINTS[agent.tier]}>
                  {TIER_LABELS[agent.tier]}
                </span>
              </div>
              {agent.primary ? <span className="tag">常用</span> : null}
            </header>
            <div className="lib-counts">
              <span className="state-chip visible">可见 {counts.visible}</span>
              {counts.hidden ? <span className="state-chip hidden">被隐藏 {counts.hidden}</span> : null}
              {counts.duplicate ? <span className="state-chip duplicate">重复 {counts.duplicate}</span> : null}
              {counts.privateCopy ? <span className="state-chip private-copy">独立副本 {counts.privateCopy}</span> : null}
              {counts.missing ? <span className="state-chip missing">看不到 {counts.missing}</span> : null}
            </div>
            {counts.topReasons.length ? (
              <ul className="lib-reasons">
                {counts.topReasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : null}
            {agent.notes ? <p className="muted small">{agent.notes}</p> : null}
          </article>
        );
      })}
    </div>
  );
}

function Dot({ entry, agentId }: { entry: LibraryEntry; agentId: string }) {
  const { agentName } = useData();
  const fanout = entry.fanout[agentId];
  if (!fanout) return <span className="vis none" aria-label="不适用" />;
  const label = `${agentName(agentId)}：${STATE_LABELS[fanout.state]}${fanout.reason ? `，${fanout.reason}` : ""}`;
  return <span className={`vis ${fanout.state}`} role="img" aria-label={label} title={label} />;
}

export function EntriesTable({ entries, agents }: { entries: LibraryEntry[]; agents: LibraryAgent[] }) {
  const { views } = useData();
  const { go } = useNav();
  const byName = new Map(views.map((view) => [view.techName.toLowerCase(), view]));
  return (
    <div className="matrix">
      <table>
        <caption className="sr-only">技能库里的技能，以及各 Agent 能否看到</caption>
        <thead>
          <tr>
            <th scope="col">技能</th>
            <th scope="col">类型</th>
            {agents.map((agent) => (
              <th scope="col" key={agent.agentId}>
                <span className="th-agent" title={agent.name}>
                  <AgentAvatar id={agent.agentId} size="xs" />
                  {agent.name}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const view = byName.get(entry.name.toLowerCase());
            return (
              <tr key={entry.name}>
                <th scope="row">
                  {view ? (
                    <button type="button" className="link-btn" onClick={() => go("skills", { skillId: view.id })}>
                      {entry.name}
                    </button>
                  ) : (
                    <span>{entry.name}</span>
                  )}
                  {entry.target ? <small className="lib-target">→ {entry.target}</small> : null}
                </th>
                <td>
                  <span className={`tag ${entry.kind === "real" ? "mute" : entry.kind === "link-internal" ? "info" : entry.kind === "broken" ? "danger" : "warn"}`}>
                    {KIND_LABELS[entry.kind]}
                  </span>
                  {entry.externalManaged ? <span className="tag mute">外部托管</span> : null}
                </td>
                {agents.map((agent) => (
                  <td key={agent.agentId}>
                    <Dot entry={entry} agentId={agent.agentId} />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
