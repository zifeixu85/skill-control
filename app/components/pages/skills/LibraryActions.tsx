"use client";

import { isUnsupported, useResource } from "../../../hooks/useResource";
import { api } from "../../../lib/api";
import { KIND_LABELS, STATE_LABELS, TIER_LABELS, type LibraryAction } from "../../../lib/library";
import type { SkillView } from "../../../lib/skill-model";
import { useNav } from "../../providers/NavProvider";
import { AgentAvatar } from "../../ui/Avatar";

/** 技能库 actions for one skill; every action opens the plan review before anything is written. */
export function LibraryActions({ view }: { view: SkillView }) {
  const library = useResource("library", () => api.library());
  const { go, setLibraryRequest } = useNav();
  if (!library.data || isUnsupported(library.error)) return null;
  const entry = library.data.entries.find((item) => item.name.toLowerCase() === view.techName.toLowerCase());
  const ask = (action: LibraryAction, title: string, agentId?: string) =>
    setLibraryRequest({ action, skill: view.techName, agents: agentId ? [agentId] : undefined, title });

  return (
    <section>
      <h3>技能库</h3>
      {!entry ? (
        <div className="source-box">
          <span className="source-label">还不在技能库里。收编后装一次，常用 Agent 都能用。</span>
          <button type="button" className="btn sm" onClick={() => ask("adopt", `把 ${view.title} 收编进技能库`)}>
            收编进技能库
          </button>
        </div>
      ) : (
        <div className="lib-skill">
          <div className="lib-skill-head">
            <span className="tag mute">{KIND_LABELS[entry.kind]}</span>
            <button type="button" className="link-btn" onClick={() => go("library")}>
              {library.data.root}/{entry.name}
            </button>
          </div>
          <div className="lib-skill-agents">
            {library.data.agents
              .filter((agent) => !agent.collapsed || entry.fanout[agent.agentId]?.state === "visible")
              .map((agent) => {
                const fanout = entry.fanout[agent.agentId];
                const state = fanout?.state || "none";
                const linked = agent.tier === "link" && state === "visible";
                return (
                  <div key={agent.agentId} className="lib-skill-agent">
                    <AgentAvatar id={agent.agentId} size="sm" />
                    <span className="nm">{agent.name}</span>
                    <span className={`state-chip ${state}`} title={fanout?.reason || TIER_LABELS[agent.tier]}>
                      {STATE_LABELS[state]}
                    </span>
                    <span className="lib-skill-acts">
                      {agent.tier === "link" && (state === "missing" || state === "private-copy") ? (
                        <button type="button" className="btn sm" onClick={() => ask("link", `把 ${entry.name} 链接到 ${agent.name}`, agent.agentId)}>
                          链接
                        </button>
                      ) : null}
                      {linked ? (
                        <button type="button" className="btn sm ghost" onClick={() => ask("unlink", `取消 ${agent.name} 里 ${entry.name} 的链接`, agent.agentId)}>
                          取消链接
                        </button>
                      ) : null}
                      {state === "visible" ? (
                        <button type="button" className="btn sm ghost" onClick={() => ask("disable", `在 ${agent.name} 停用 ${entry.name}`, agent.agentId)}>
                          停用
                        </button>
                      ) : null}
                    </span>
                  </div>
                );
              })}
          </div>
          <button type="button" className="btn sm ghost danger-text" onClick={() => ask("remove", `把 ${entry.name} 移到回收站`)}>
            移到回收站
          </button>
        </div>
      )}
    </section>
  );
}
