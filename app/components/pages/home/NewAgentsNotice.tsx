"use client";

import { useState } from "react";
import { invalidateResources, isUnsupported, useResource } from "../../../hooks/useResource";
import { MAX_PRIMARY_AGENTS } from "../../../lib/agents";
import { api, errorMessage } from "../../../lib/api";
import { customAgentFrom, newAgents, openCandidates, type DiscoveryCandidate } from "../../../lib/discovery";
import { joinNames } from "../../../lib/format";
import type { ScanAgent } from "../../../lib/types";
import { DATA_KEYS, useData } from "../../providers/DataProvider";
import { useNav } from "../../providers/NavProvider";
import { useToast } from "../../providers/ToastProvider";
import { AgentAvatar, LetterLogo } from "../../ui/Avatar";

export const DISCOVER_KEY = "agents:discover";

/** Mark Agents as seen: the service endpoint, or the config field when the service is older. */
export function useAcknowledge() {
  const { config, updateConfig } = useData();
  return async (ids: string[]) => {
    try {
      await api.acknowledgeAgents(ids);
    } catch (error) {
      if (!isUnsupported(error instanceof Error ? error : null)) throw error;
      const known = config.data?.knownAgentIds || [];
      await updateConfig({ knownAgentIds: [...new Set([...known, ...ids])] });
    }
    await invalidateResources(DATA_KEYS.scan, DATA_KEYS.config);
  };
}

function NewAgentRow({ agent, busy, run }: { agent: ScanAgent; busy: boolean; run: (label: string, task: () => Promise<unknown>) => void }) {
  const { go } = useNav();
  const { primary, updateConfig } = useData();
  const acknowledge = useAcknowledge();
  const full = primary.length >= MAX_PRIMARY_AGENTS;
  return (
    <li className="discovery-row">
      <AgentAvatar id={agent.id} size="md" />
      <div className="it-main">
        <div className="it-title">{agent.name}</div>
        <div className="it-meta">
          {agent.skillCount} 个技能{agent.productVersion ? ` · ${agent.productVersion}` : ""}
        </div>
      </div>
      <div className="it-acts">
        <button type="button" className="btn sm ghost" onClick={() => go("agent", { agentId: agent.id })}>
          查看
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={busy || full}
          title={full ? `最多 ${MAX_PRIMARY_AGENTS} 个常用 Agent，先在设置里取消一个` : "加入常用 Agent，并标为已知"}
          onClick={() =>
            run(`已把 ${agent.name} 设为常用`, async () => {
              await updateConfig({ primaryAgentIds: [...primary, agent.id] });
              await acknowledge([agent.id]);
            })
          }
        >
          设为常用
        </button>
        <button type="button" className="btn sm" disabled={busy} title="以后不再提示" onClick={() => run(`已把 ${agent.name} 标为已知`, () => acknowledge([agent.id]))}>
          知道了
        </button>
      </div>
    </li>
  );
}

function CandidateRow({ candidate, busy, run }: { candidate: DiscoveryCandidate; busy: boolean; run: (label: string, task: () => Promise<unknown>) => void }) {
  const { config, updateConfig } = useData();
  const add = () =>
    run(`已添加自定义 Agent：${candidate.guessName}`, async () => {
      const agents = config.data?.agents || [];
      const entry = customAgentFrom(candidate, agents);
      await updateConfig({ agents: [...agents, entry], knownAgentIds: [...new Set([...(config.data?.knownAgentIds || []), entry.id])] });
      await invalidateResources(DATA_KEYS.scan, DISCOVER_KEY);
    });
  const ignore = () =>
    run(`已忽略 ${candidate.guessName}`, async () => {
      // The service keeps ignored folders by path (~/…), not by the guessed id.
      await updateConfig({ ignoredDiscoveries: [...new Set([...(config.data?.ignoredDiscoveries || []), candidate.path])] });
      await invalidateResources(DISCOVER_KEY);
    });
  return (
    <li className="discovery-row">
      <LetterLogo text={candidate.guessName} tone="mute" />
      <div className="it-main">
        <div className="it-title">
          {candidate.guessName}
          <span className="tag mute">未知 Agent</span>
        </div>
        <div className="it-meta mono clamp-1" title={candidate.path}>
          {candidate.path} · {candidate.skillCount} 个技能
        </div>
        {candidate.reason && !candidate.reason.includes(candidate.path) ? <div className="it-desc clamp-2">{candidate.reason}</div> : null}
      </div>
      <div className="it-acts">
        <button type="button" className="btn sm" disabled={busy} title="把这个文件夹当作一个 Agent 读取它的技能，写入设置" onClick={add}>
          添加为自定义 Agent
        </button>
        <button type="button" className="btn sm ghost" disabled={busy} title="以后不再提示这个文件夹" onClick={ignore}>
          忽略
        </button>
      </div>
    </li>
  );
}

/** 首页 / 设置: "发现新 Agent：X" — detected-but-new Agents and folders that look like one. */
export function NewAgentsNotice() {
  const { agents, config } = useData();
  const toast = useToast();
  const discovered = useResource(DISCOVER_KEY, () => api.discoverAgents());
  const [busy, setBusy] = useState(false);
  const acknowledge = useAcknowledge();
  const fresh = newAgents(agents);
  const candidates = isUnsupported(discovered.error) ? [] : openCandidates(discovered.data || [], config.data);
  if (!fresh.length && !candidates.length) return null;
  const run = (label: string, task: () => Promise<unknown>) => {
    setBusy(true);
    void task()
      .then(() => toast.show(label))
      .catch((error) => toast.show(errorMessage(error, "保存失败。"), { tone: "error" }))
      .finally(() => setBusy(false));
  };
  const names = [...fresh.map((agent) => agent.name), ...candidates.map((candidate) => candidate.guessName)];
  return (
    <section className="notice-card discovery" aria-labelledby="new-agents-title" aria-busy={busy || undefined}>
      <header>
        <b id="new-agents-title">发现新 Agent：{joinNames(names.slice(0, 3))}{names.length > 3 ? ` 等 ${names.length} 个` : ""}</b>
        {fresh.length > 1 ? (
          <button type="button" className="btn sm ghost" disabled={busy} onClick={() => run("已全部标为已知", () => acknowledge(fresh.map((agent) => agent.id)))}>
            全部知道了
          </button>
        ) : null}
      </header>
      <p>新装的 Agent 不会自动变成常用；设为常用后，Skill Control 才会按它检查差异和多份副本。</p>
      <ul>
        {fresh.map((agent) => (
          <NewAgentRow key={agent.id} agent={agent} busy={busy} run={run} />
        ))}
        {candidates.map((candidate) => (
          <CandidateRow key={candidate.id} candidate={candidate} busy={busy} run={run} />
        ))}
      </ul>
    </section>
  );
}
