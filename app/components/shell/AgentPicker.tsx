"use client";

import { activityLine, detectedHint, MAX_PRIMARY_AGENTS, noSkillsYet, pickableAgents } from "../../lib/agents";
import type { ScanAgent } from "../../lib/types";
import { useData } from "../providers/DataProvider";
import { AgentAvatar } from "../ui/Avatar";

/** Agents worth offering as "常用": every installed one, busiest first (see lib/agents). */
export function candidateAgents(agents: ScanAgent[], weight: (id: string) => number): ScanAgent[] {
  return pickableAgents(agents, weight);
}

export function AgentPicker({
  name,
  selected,
  onChange,
  onLimit,
  disabled,
}: {
  name: string;
  selected: string[];
  onChange: (next: string[]) => void;
  onLimit: (message: string) => void;
  disabled?: boolean;
}) {
  const { agents, activityById, scan, usage } = useData();
  const suggested = new Set(scan.data?.suggestedPrimaryAgentIds || []);
  const list = candidateAgents(agents, (id) => activityById.get(id)?.weight30d || 0);
  const toggle = (id: string, checked: boolean) => {
    if (checked) {
      if (selected.length >= MAX_PRIMARY_AGENTS) {
        onLimit(`最多选 ${MAX_PRIMARY_AGENTS} 个常用 Agent`);
        return;
      }
      onChange([...selected, id]);
      return;
    }
    if (selected.length <= 1) {
      onLimit("至少保留一个常用 Agent");
      return;
    }
    onChange(selected.filter((item) => item !== id));
  };
  if (!list.length) return <p className="muted small">还没有检测到已安装的 Agent。装好后到“概览”点“重新扫描”。</p>;
  return (
    <fieldset className="pick" disabled={disabled} aria-busy={disabled || undefined}>
      <legend className="sr-only">常用 Agent</legend>
      {list.map((agent) => {
        const on = selected.includes(agent.id);
        const line = agent.refuseInstall
          ? "技能由它自己管理 · 只读"
          : activityLine(activityById.get(agent.id), usage.data?.agents.find((item) => item.agentId === agent.id) || null);
        const empty = noSkillsYet(agent);
        return (
          <label
            key={agent.id}
            className={on ? "on" : ""}
            title={[agent.name, line, empty ? "还没有技能" : `${agent.skillCount} 个技能`, detectedHint(agent.detectedBy, 4)].filter(Boolean).join(" · ")}
          >
            <AgentAvatar id={agent.id} size="md" />
            <span className="pick-text">
              <span className="pick-name">
                <b>{agent.name}</b>
                {suggested.has(agent.id) ? <span className="tag info pick-chip">推荐</span> : null}
                {empty ? <span className="tag mute pick-chip">还没有技能</span> : null}
              </span>
              <span className="pick-line">{line}</span>
              <span className="pick-line">{empty ? detectedHint(agent.detectedBy) || "还没有技能，也可以先选上" : `${agent.skillCount} 个技能`}</span>
            </span>
            <span className="pick-check">
              <input
                type="checkbox"
                name={name}
                value={agent.id}
                checked={on}
                onChange={(event) => toggle(agent.id, event.target.checked)}
              />
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
