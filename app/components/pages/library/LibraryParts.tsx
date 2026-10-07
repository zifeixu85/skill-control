"use client";

import { useOpenedItem } from "../../../hooks/usePageMemory";
import { markOpened } from "../../../lib/page-memory";
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
import type { ChipSpec } from "../../../lib/chips";
import { useData } from "../../providers/DataProvider";
import { useNav } from "../../providers/NavProvider";
import { AgentAvatar } from "../../ui/Avatar";
import { ChipRow, ItemText, TagStack } from "../../ui/Item";

/** Visibility counts as colored chips, problems before the rest, number emphasised. */
function visibilityChips(counts: ReturnType<typeof agentCounts>): ChipSpec[] {
  const chip = (id: string, value: number, text: string, tone: ChipSpec["tone"]): ChipSpec => ({
    id,
    kind: "status",
    tone,
    text: `${text} ${value}`,
    count: { before: `${text} `, value },
  });
  const chips: ChipSpec[] = [];
  if (counts.hidden) chips.push(chip("hidden", counts.hidden, "被隐藏", "danger"));
  if (counts.duplicate) chips.push(chip("duplicate", counts.duplicate, "重复", "warn"));
  if (counts.privateCopy) chips.push(chip("private", counts.privateCopy, "独立副本", "info"));
  if (counts.missing) chips.push(chip("missing", counts.missing, "看不到", "mute"));
  chips.push(chip("visible", counts.visible, "可见", "ok"));
  return chips;
}

export function AgentStrip({ data, agents }: { data: LibraryData; agents: LibraryAgent[] }) {
  return (
    <div className="lib-agents card-grid">
      {agents.map((agent) => {
        const counts = agentCounts(data, agent.agentId);
        const desc = counts.topReasons.join("；") || agent.notes;
        return (
          <article key={agent.agentId} className={`lib-agent card ${agent.primary ? "primary" : ""}`}>
            <div className="card-head">
              <AgentAvatar id={agent.agentId} size="md" />
              <ItemText title={agent.name} meta={<span title={TIER_HINTS[agent.tier]}>{TIER_LABELS[agent.tier]}</span>} />
              {agent.primary ? <span className="tag card-status">常用</span> : <span />}
            </div>
            <p className="card-desc" title={agent.notes || undefined}>
              {desc || "没有需要说明的情况。"}
            </p>
            <ChipRow className="card-foot" chips={visibilityChips(counts)} max={4} />
          </article>
        );
      })}
    </div>
  );
}

function entryChips(entry: LibraryEntry): ChipSpec[] {
  const tone: ChipSpec["tone"] = entry.kind === "real" ? "mute" : entry.kind === "link-internal" ? "info" : entry.kind === "broken" ? "danger" : "warn";
  const chips: ChipSpec[] = [{ id: "kind", kind: entry.kind === "real" ? "kind" : "status", tone, text: KIND_LABELS[entry.kind] }];
  if (entry.externalManaged) chips.push({ id: "external", kind: "kind", text: "外部托管" });
  return chips;
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
  const opened = useOpenedItem("library");
  const byName = new Map(views.map((view) => [view.techName.toLowerCase(), view]));
  return (
    <div className="matrix">
      <table>
        <caption className="sr-only">技能库里的技能，以及各 Agent 能否看到</caption>
        <thead>
          <tr>
            <th scope="col">技能</th>
            <th scope="col" className="th-tags">标记</th>
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
              <tr key={entry.name} data-memory-id={entry.name} className={opened === entry.name ? "opened" : undefined}>
                <th scope="row" className="cell-main">
                  <ItemText
                    title={
                      view ? (
                        <button
                          type="button"
                          className="link-btn"
                          onClick={() => {
                            markOpened("library", entry.name);
                            go("skills", { skillId: view.id });
                          }}
                        >
                          {entry.name}
                        </button>
                      ) : (
                        entry.name
                      )
                    }
                    titleText={entry.name}
                    meta={entry.target ? `→ ${entry.target}` : null}
                    mono
                  />
                </th>
                <td className="cell-tags">
                  <TagStack chips={entryChips(entry)} />
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
