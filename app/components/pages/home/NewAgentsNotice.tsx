"use client";

import { useState } from "react";
import { usePersistent } from "../../../hooks/usePersistent";
import { invalidateResources, isUnsupported, useResource } from "../../../hooks/useResource";
import { MAX_PRIMARY_AGENTS } from "../../../lib/agents";
import { api, errorMessage } from "../../../lib/api";
import {
  allDismissed,
  customAgentFrom,
  discoveryKeys,
  newAgents,
  openCandidates,
  parseDismissed,
  serializeDismissed,
  sortCandidates,
  type DiscoveryCandidate,
} from "../../../lib/discovery";
import { joinNames } from "../../../lib/format";
import { persistentStore } from "../../../lib/storage";
import type { ScanAgent } from "../../../lib/types";
import { DATA_KEYS, useData } from "../../providers/DataProvider";
import { useNav } from "../../providers/NavProvider";
import { useToast } from "../../providers/ToastProvider";
import { CloseIcon } from "../../icons";
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

type Run = (label: string, task: () => Promise<unknown>) => void;

/** Everything new, in display order: detected Agents first, then folders by skill count. */
export function useDiscovery() {
  const { agents, config } = useData();
  const toast = useToast();
  const discovered = useResource(DISCOVER_KEY, () => api.discoverAgents());
  const [busy, setBusy] = useState(false);
  const fresh = newAgents(agents);
  const candidates = sortCandidates(isUnsupported(discovered.error) ? [] : openCandidates(discovered.data || [], config.data));
  const run: Run = (label, task) => {
    setBusy(true);
    void task()
      .then(() => toast.show(label))
      .catch((error) => toast.show(errorMessage(error, "保存失败。"), { tone: "error" }))
      .finally(() => setBusy(false));
  };
  const keys = discoveryKeys(fresh, candidates);
  const names = [...fresh.map((agent) => agent.name), ...candidates.map((candidate) => candidate.guessName)];
  return { fresh, candidates, keys, names, total: fresh.length + candidates.length, busy, run };
}

export function DiscoveryRows({ fresh, candidates, busy, run }: { fresh: ScanAgent[]; candidates: DiscoveryCandidate[]; busy: boolean; run: Run }) {
  return (
    <ul>
      {fresh.map((agent) => (
        <NewAgentRow key={agent.id} agent={agent} busy={busy} run={run} />
      ))}
      {candidates.map((candidate) => (
        <CandidateRow key={candidate.id} candidate={candidate} busy={busy} run={run} />
      ))}
    </ul>
  );
}

/** "全部忽略": mark every detected Agent as known and ignore every folder, in two writes. */
export function useIgnoreAll() {
  const { config, updateConfig } = useData();
  const acknowledge = useAcknowledge();
  return async (fresh: ScanAgent[], candidates: DiscoveryCandidate[]) => {
    if (fresh.length) await acknowledge(fresh.map((agent) => agent.id));
    if (candidates.length) {
      await updateConfig({ ignoredDiscoveries: [...new Set([...(config.data?.ignoredDiscoveries || []), ...candidates.map((candidate) => candidate.path)])] });
      await invalidateResources(DISCOVER_KEY);
    }
  };
}

const MAX_ROWS = 3;

/**
 * 首页 / 设置: "发现新 Agent：X、Y 等 N 个" — one summary line and at most 3 rows; the full list
 * opens in a side panel. On 首页 the × hides the card until something new shows up.
 */
export function NewAgentsNotice({ place = "home" }: { place?: "home" | "settings" }) {
  const { openDrawer } = useNav();
  const { fresh, candidates, keys, names, total, busy, run } = useDiscovery();
  const [dismissedText, setDismissed] = usePersistent(dismissedStore);
  const [confirming, setConfirming] = useState(false);
  const ignoreAll = useIgnoreAll();
  if (!total) return null;
  const dismissed = parseDismissed(dismissedText);
  if (place === "home" && allDismissed(keys, dismissed)) return null;
  const shownFresh = fresh.slice(0, MAX_ROWS);
  const shownCandidates = candidates.slice(0, Math.max(0, MAX_ROWS - shownFresh.length));
  const summary = [fresh.length ? `${fresh.length} 个新检测到的 Agent` : "", candidates.length ? `${candidates.length} 个像 Agent 的文件夹` : ""].filter(Boolean).join("，");
  return (
    <section className="notice-card discovery" aria-labelledby={`new-agents-title-${place}`} aria-busy={busy || undefined}>
      <header>
        <b id={`new-agents-title-${place}`} className="clamp-1">
          发现新 Agent：{joinNames(names.slice(0, 3))}
          {names.length > 3 ? ` 等 ${names.length} 个` : ""}
        </b>
        {place === "home" ? (
          <button
            type="button"
            className="btn ghost sm icon-only"
            aria-label="先不提示，有新的再说"
            title="先不提示，有新的再说"
            onClick={() => setDismissed(serializeDismissed(new Set([...dismissed, ...keys])))}
          >
            <CloseIcon />
          </button>
        ) : null}
      </header>
      <p>{summary}。新装的 Agent 不会自动变成常用，设为常用后才会按它检查差异和多份副本。</p>
      <DiscoveryRows fresh={shownFresh} candidates={shownCandidates} busy={busy} run={run} />
      <footer className="discovery-foot">
        {confirming ? (
          <>
            <span className="discovery-confirm">
              把这 {total} 个都标为已知或忽略？以后不再提示它们；已经装上的 Agent 照常显示在侧栏里。
            </span>
            <button type="button" className="btn sm ghost" disabled={busy} onClick={() => setConfirming(false)}>
              取消
            </button>
            <button
              type="button"
              className="btn sm danger"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                run(`已忽略 ${total} 个`, () => ignoreAll(fresh, candidates));
              }}
            >
              确认全部忽略
            </button>
          </>
        ) : (
          <>
            {total > shownFresh.length + shownCandidates.length ? (
              <button type="button" className="btn sm" data-detail-trigger="" onClick={() => openDrawer({ kind: "discovery", id: "all" })}>
                查看全部 {total} 个
              </button>
            ) : null}
            <button type="button" className="btn sm ghost" disabled={busy} onClick={() => setConfirming(true)}>
              全部忽略
            </button>
          </>
        )}
      </footer>
    </section>
  );
}

const dismissedStore = persistentStore<string>("discovery-dismissed", "", (value) => value.length < 40_000);
