"use client";

import { isUnsupported, useResource } from "../../../hooks/useResource";
import { api } from "../../../lib/api";
import { KIND_LABELS, STATE_LABELS, TIER_HINTS, TIER_LABELS, type LibraryAction } from "../../../lib/library";
import { consentRequest } from "../../../lib/library-review";
import type { SkillView } from "../../../lib/skill-model";
import { useNav } from "../../providers/NavProvider";
import { AgentAvatar } from "../../ui/Avatar";

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

  return (
    <section>
      <h3>技能库</h3>
      {!entry ? (
        <div className="source-box">
          <span className="source-label">还不在技能库里。放进 ~/.agents/skills 后，会自动读取技能库的 Agent 直接能看到，其他 Agent 再逐个接入。</span>
          <button type="button" className="btn sm" onClick={() => ask("adopt", `把 ${view.title} 放进技能库`)}>
            放进技能库
          </button>
        </div>
      ) : (
        <div className="lib-skill">
          <div className="lib-skill-head">
            <span className="tag mute">{KIND_LABELS[entry.kind]}</span>
            <button type="button" className="link-btn" onClick={() => go("library")}>
              {library.data.root}/{skill}
            </button>
          </div>
          <div className="lib-skill-agents">
            {library.data.agents
              .filter((agent) => !agent.collapsed || entry.fanout[agent.agentId]?.state === "visible")
              .map((agent) => {
                const fanout = entry.fanout[agent.agentId];
                const state = fanout?.state || "none";
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
