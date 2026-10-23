"use client";

import { activitySummary, MAX_PRIMARY_AGENTS } from "../../lib/agents";
import type { ScanAgent } from "../../lib/types";
import { useData } from "../providers/DataProvider";
import { AgentAvatar } from "../ui/Avatar";

/** Agents worth offering as "常用": installed with skills or recent activity, busiest first. */
export function candidateAgents(agents: ScanAgent[], weight: (id: string) => number): ScanAgent[] {
  return agents
    .filter((agent) => agent.available && (agent.skillCount > 0 || weight(agent.id) > 0))
    .sort((left, right) => weight(right.id) - weight(left.id) || right.skillCount - left.skillCount);
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
  const { agents, activityById, scan } = useData();
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
  return (
    <fieldset className="pick" disabled={disabled} aria-busy={disabled || undefined}>
      <legend className="sr-only">常用 Agent</legend>
      {list.map((agent) => {
        const on = selected.includes(agent.id);
        const line = agent.refuseInstall ? "技能由它自己管理 · 只读" : activitySummary(activityById.get(agent.id));
        return (
          <label key={agent.id} className={on ? "on" : ""} title={`${agent.name} · ${line} · ${agent.skillCount} 个技能`}>
            <AgentAvatar id={agent.id} size="md" />
            <span className="pick-text">
              <span className="pick-name">
                <b>{agent.name}</b>
                {suggested.has(agent.id) ? <span className="tag info pick-chip">推荐</span> : null}
              </span>
              <span className="pick-line">{line}</span>
              <span className="pick-line">{agent.skillCount} 个技能</span>
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
