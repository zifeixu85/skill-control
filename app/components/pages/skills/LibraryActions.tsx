"use client";

import { isUnsupported, useResource } from "../../../hooks/useResource";
import { api } from "../../../lib/api";
import { formatMonthDay } from "../../../lib/format";
import { KIND_LABELS, STATE_LABELS, TIER_HINTS, TIER_LABELS, type LibraryAction, type LibraryAgent, type LibraryEntry } from "../../../lib/library";
import { consentRequest } from "../../../lib/library-review";
import type { SkillView } from "../../../lib/skill-model";
import { PauseIcon, PlayIcon } from "../../icons";
import { useNav } from "../../providers/NavProvider";
import { AgentAvatar } from "../../ui/Avatar";

/** States in which a pause has something to turn off. */
const PAUSABLE = new Set(["visible", "duplicate", "private-copy"]);

/** 暂停中: since when, who can't use it, who still can, and the way back. */
function PausedBanner({ entry, agents, onResume }: { entry: LibraryEntry; agents: LibraryAgent[]; onResume: () => void }) {
  const name = (agentId: string) => agents.find((agent) => agent.agentId === agentId)?.name || agentId;
  const off = entry.paused?.agents || [];
  // Agents that still see it: no switch to turn (they read the library themselves), or it needed a manual step.
  const still = agents.filter((agent) => !off.includes(agent.agentId) && ["visible", "duplicate"].includes(entry.fanout[agent.agentId]?.state || ""));
  const since = formatMonthDay(entry.paused?.since);
  return (
    <div className="lib-paused" role="status">
      <PauseIcon className="lib-paused-icon" />
      <div className="lib-paused-text">
        <b>{since ? `${since}起暂停` : "已暂停"}</b>
        <span>{off.map(name).join("、")} 暂时调用不了</span>
        {still.length ? <span>{still.map((agent) => agent.name).join("、")} 仍能用（没有可用的停用开关）</span> : null}
      </div>
      <button type="button" className="btn sm primary" onClick={onResume}>
        <PlayIcon />
        恢复此技能
      </button>
    </div>
  );
}

/** 技能库 actions for one skill; every action opens the plan review before anything is written. */
export function LibraryActions({ view }: { view: SkillView }) {
  const library = useResource("library", () => api.library());
  const { go, setLibraryRequest } = useNav();
  if (!library.data || isUnsupported(library.error)) return null;
  const entry = library.data.entries.find((item) => item.name.toLowerCase() === view.techName.toLowerCase());
  // One identifier for every request: the library's own name when it has the skill.
  const skill = entry?.name ?? view.techName;
  const ask = (action: LibraryAction, title: string, agentId?: string) =>
    setLibraryRequest({ action, skill, agents: agentId ? [agentId] : undefined, title });

  const paused = entry?.paused || null;
  const pausable = Boolean(entry && entry.kind !== "broken" && !paused && library.data.agents.some((agent) => PAUSABLE.has(entry.fanout[agent.agentId]?.state || "")));

  return (
    <section>
      <div className="lib-section-head">
        <h3>技能库</h3>
        {pausable ? (
          <button type="button" className="btn sm" title="让 Agent 暂时调用不了它；技能本身留在库里，随时可以恢复" onClick={() => ask("pause", `暂停「${view.title}」`)}>
            <PauseIcon />
            暂停此技能
          </button>
        ) : null}
      </div>
      {!entry ? (
        <div className="source-box">
          <span className="source-label">还不在技能库里。放进 ~/.agents/skills 后，会自动读取技能库的 Agent 直接能看到，其他 Agent 再逐个接入。</span>
          <button type="button" className="btn sm" onClick={() => ask("adopt", `把 ${view.title} 放进技能库`)}>
            放进技能库
          </button>
        </div>
      ) : (
        <div className="lib-skill">
          {paused ? <PausedBanner entry={entry} agents={library.data.agents} onResume={() => ask("resume", `恢复「${view.title}」`)} /> : null}
          <div className="lib-skill-head">
            <span className="tag mute">{KIND_LABELS[entry.kind]}</span>
            <button type="button" className="link-btn" onClick={() => go("library")}>
              {library.data.root}/{skill}
            </button>
          </div>
          <div className="lib-skill-agents">
            {library.data.agents
              .filter((agent) => !agent.collapsed || entry.fanout[agent.agentId]?.state === "visible" || entry.fanout[agent.agentId]?.paused)
              .map((agent) => {
                const fanout = entry.fanout[agent.agentId];
                const state = fanout?.state || "none";
                if (fanout?.paused) {
                  return (
                    <div key={agent.agentId} className="lib-skill-agent">
                      <AgentAvatar id={agent.agentId} size="sm" />
                      <span className="nm">{agent.name}</span>
                      <span className="state-chip paused" title="暂停此技能时关掉的；点「恢复此技能」改回来">
                        已暂停
                      </span>
                      <span className="lib-skill-acts" />
                    </div>
                  );
                }
                const linked = agent.tier === "link" && state === "visible";
                const connectable = (agent.tier === "link" || agent.tier === "copy") && (state === "missing" || state === "private-copy");
                // Hermes reads the library through one config change, asked for once on the 技能库 page.
                const needsConsent = agent.tier === "config" && agent.primary && state === "missing";
                return (
                  <div key={agent.agentId} className="lib-skill-agent">
                    <AgentAvatar id={agent.agentId} size="sm" />
                    <span className="nm">{agent.name}</span>
                    <span className={`state-chip ${state}`} title={fanout?.reason || TIER_LABELS[agent.tier]}>
                      {STATE_LABELS[state]}
                    </span>
                    <span className="lib-skill-acts">
                      {connectable ? (
                        <button
                          type="button"
                          className="btn sm"
                          title={`${TIER_LABELS[agent.tier]}：${TIER_HINTS[agent.tier]}`}
                          onClick={() => ask("link", `把 ${view.title} 接入 ${agent.name}`, agent.agentId)}
                        >
                          接入
                        </button>
                      ) : null}
                      {needsConsent ? (
                        <button
                          type="button"
                          className="btn sm"
                          title={TIER_HINTS.config}
                          onClick={() => setLibraryRequest(consentRequest(agent.agentId, agent.name))}
                        >
                          接入
                        </button>
                      ) : null}
                      {linked ? (
                        <button
                          type="button"
                          className="btn sm ghost"
                          title="自动接入以后不会再把它接回来"
                          onClick={() => ask("unlink", `取消 ${agent.name} 对 ${view.title} 的接入`, agent.agentId)}
                        >
                          取消接入
                        </button>
                      ) : null}
                      {state === "visible" ? (
                        <button type="button" className="btn sm ghost" onClick={() => ask("disable", `在 ${agent.name} 停用 ${view.title}`, agent.agentId)}>
                          停用
                        </button>
                      ) : null}
                    </span>
                  </div>
                );
              })}
          </div>
          <button type="button" className="btn sm ghost danger-text" onClick={() => ask("remove", `把 ${view.title} 移到回收站`)}>
            移到回收站
          </button>
        </div>
      )}
    </section>
  );
}
