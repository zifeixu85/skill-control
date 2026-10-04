"use client";

import { useState } from "react";
import { useNow } from "../../../hooks/useNow";
import { invalidateResources } from "../../../hooks/useResource";
import { api, errorMessage } from "../../../lib/api";
import { formatRelative } from "../../../lib/format";
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
import { useToast } from "../../providers/ToastProvider";
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

export function TrashList({ data }: { data: LibraryData }) {
  const toast = useToast();
  const now = useNow();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!data.trash.length) return <p className="muted small">回收站是空的。</p>;
  const restore = async (trashId: string, name: string) => {
    setBusy(true);
    try {
      await api.libraryRestore(trashId);
      toast.show(`已把 ${name} 恢复到技能库`);
      setConfirming(null);
      await invalidateResources("library", "scan", "health-report");
    } catch (error) {
      toast.show(errorMessage(error, "恢复失败。"), { tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="copies">
      {data.trash.map((item) => (
        <div key={item.trashId}>
          <code>{item.name}</code>
          <em>{item.removedAt && now ? `${formatRelative(item.removedAt, now)}移入` : ""}</em>
          <em>{item.links.length ? `${item.links.length} 个链接会一起恢复` : ""}</em>
          {confirming === item.trashId ? (
            <span className="inline-confirm">
              <button type="button" className="btn sm primary" disabled={busy} onClick={() => void restore(item.trashId, item.name)}>
                {busy ? "正在恢复…" : "确认恢复"}
              </button>
              <button type="button" className="btn sm ghost" disabled={busy} onClick={() => setConfirming(null)}>
                取消
              </button>
            </span>
          ) : (
            <button type="button" className="btn sm" onClick={() => setConfirming(item.trashId)}>
              恢复
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
