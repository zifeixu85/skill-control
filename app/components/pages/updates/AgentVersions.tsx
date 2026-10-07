"use client";

import { useId, useState } from "react";
import { useNow } from "../../../hooks/useNow";
import { usePageMemory } from "../../../hooks/usePageMemory";
import { invalidateResources, isUnsupported, primeResource, useResource } from "../../../hooks/useResource";
import {
  AGENT_VERSION_LABELS,
  AGENT_VERSION_TONES,
  inAppHint,
  versionSourceLabel,
  type AgentVersion,
  type AgentVersionsReport,
} from "../../../lib/agent-versions";
import { api, errorMessage } from "../../../lib/api";
import { isHttpsUrl } from "../../../lib/external";
import { formatDateTime, formatMonthDay, formatRelative } from "../../../lib/format";
import { RefreshIcon } from "../../icons";
import { useToast } from "../../providers/ToastProvider";
import { AgentAvatar } from "../../ui/Avatar";
import { SectionHeading } from "../../ui/basics";
import { ExternalLink } from "../../ui/ExternalLink";
import { RemedyButton, RemedyPanel } from "../../ui/RemedyPanel";

export const AGENT_VERSIONS_KEY = "agent-versions";
export const loadAgentVersions = () => api.agentVersions();

/** "已检查 3 小时前 · 每天自动检查一次", or why nothing was checked. */
export function checkedNote(report: AgentVersionsReport, now: number | null): string {
  if (report.offline) return "离线模式：没有联网检查，只显示本机安装的版本";
  const last = report.checkedAt ? `${now ? formatRelative(report.checkedAt, now) : formatDateTime(report.checkedAt)}检查` : "还没有检查过";
  return `${last} · 每天自动检查一次`;
}

function VersionPair({ agent }: { agent: AgentVersion }) {
  const current = agent.installed?.version;
  const latest = agent.latest?.version;
  return (
    <span className="versions">
      <code>{current || "未知"}</code>
      {latest && latest !== current ? (
        <>
          {" → "}
          <code className={agent.status === "update-available" ? "latest" : ""}>{latest}</code>
        </>
      ) : null}
    </span>
  );
}

function AgentVersionRow({ agent }: { agent: AgentVersion }) {
  const now = useNow();
  const [open, setOpen] = useState(false);
  const remedyId = useId();
  const source = versionSourceLabel(agent.latest?.source || null);
  const installedFrom = versionSourceLabel(agent.installed?.source || null);
  const hasCommands = Boolean(agent.remedy?.commands.length);
  const needsUpdate = agent.status === "update-available";
  return (
    <li className="avrow" data-memory-id={`agent:${agent.agentId}`}>
      <AgentAvatar id={agent.agentId} size="md" />
      <div className="it-main">
        <div className="it-title av-title">
          <span>{agent.name}</span>
          <span className={`tag ${AGENT_VERSION_TONES[agent.status] === "ok" ? "" : AGENT_VERSION_TONES[agent.status]}`}>{AGENT_VERSION_LABELS[agent.status]}</span>
        </div>
        <div className="it-meta">
          <span>当前</span> <VersionPair agent={agent} />
          {source ? (
            <>
              <span className="sep">·</span>
              <span>最新版本来自{source}</span>
            </>
          ) : null}
          {agent.latest?.releasedAt ? (
            <>
              <span className="sep">·</span>
              <span>{formatMonthDay(agent.latest.releasedAt, now || undefined)}发布</span>
            </>
          ) : null}
        </div>
        {agent.error ? <div className="it-desc danger-text">{agent.error}</div> : null}
        {!agent.error && agent.status === "unknown" ? (
          <div className="it-desc">{agent.installed ? "查不到最新版本，无法比较。" : "找不到本机安装的版本。"}</div>
        ) : null}
        {needsUpdate && !hasCommands ? <div className="it-desc">{inAppHint(agent.name)}</div> : null}
        {installedFrom && agent.installed?.path ? (
          <div className="it-desc mono" title={agent.installed.path}>
            {installedFrom} · {agent.installed.path}
          </div>
        ) : null}
      </div>
      <div className="it-acts">
        {isHttpsUrl(agent.latest?.notesUrl) ? (
          <ExternalLink className="btn sm ghost" href={agent.latest.notesUrl}>
            更新说明
          </ExternalLink>
        ) : null}
        {isHttpsUrl(agent.latest?.url) ? (
          <ExternalLink className="btn sm ghost" href={agent.latest.url}>
            官网
          </ExternalLink>
        ) : null}
        {needsUpdate && agent.remedy && hasCommands ? <RemedyButton open={open} onToggle={() => setOpen((value) => !value)} controls={remedyId} /> : null}
      </div>
      {open && agent.remedy ? (
        <div className="remedy-slot">
          <RemedyPanel id={remedyId} remedy={agent.remedy} label={agent.name} />
        </div>
      ) : null}
    </li>
  );
}

/** 更新 · Agent 软件: installed vs latest for each agent app or CLI. */
export function AgentVersions() {
  const report = useResource(AGENT_VERSIONS_KEY, loadAgentVersions);
  const now = useNow();
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const [showAll, setShowAll] = usePageMemory<boolean>("updates:agents-all", false);
  if (isUnsupported(report.error)) return null;
  const check = async () => {
    setChecking(true);
    try {
      const fresh = await api.checkAgentVersions();
      if (fresh) primeResource(AGENT_VERSIONS_KEY, fresh);
      else await invalidateResources(AGENT_VERSIONS_KEY);
      toast.show("Agent 版本检查完成");
    } catch (error) {
      toast.show(errorMessage(error, "检查 Agent 版本失败。"), { tone: "error" });
    } finally {
      setChecking(false);
    }
  };
  const data = report.data;
  const current = data ? data.agents.filter((agent) => agent.status === "up-to-date") : [];
  const rest = data ? data.agents.filter((agent) => agent.status !== "up-to-date") : [];
  const shown = showAll ? [...rest, ...current] : rest;
  return (
    <section aria-labelledby="agent-versions-title">
      <SectionHeading
        id="agent-versions-title"
        title="Agent 软件"
        note={data ? checkedNote(data, now) : "正在读取…"}
        action={
          <button type="button" className="btn sm ghost" disabled={checking || !data || data.offline} onClick={() => void check()}>
            <RefreshIcon className={checking ? "spin" : ""} />
            {checking ? "正在检查…" : "立即检查"}
          </button>
        }
      />
      {report.status === "error" && !data ? (
        <p className="index-note error" role="alert">
          读取 Agent 版本失败：{errorMessage(report.error)}
        </p>
      ) : null}
      {data && !data.agents.length ? <p className="muted small">没有找到可以检查版本的 Agent。</p> : null}
      {shown.length ? (
        <ul className="avlist">
          {shown.map((agent) => (
            <AgentVersionRow key={agent.agentId} agent={agent} />
          ))}
        </ul>
      ) : data && data.agents.length ? (
        <p className="muted small">{data.agents.length} 个 Agent 都是最新版本。</p>
      ) : null}
      {current.length && rest.length ? (
        <button type="button" className="btn sm ghost" onClick={() => setShowAll(!showAll)}>
          {showAll ? "只看需要留意的" : `另有 ${current.length} 个已是最新`}
        </button>
      ) : current.length && !rest.length ? (
        <button type="button" className="btn sm ghost" onClick={() => setShowAll(!showAll)}>
          {showAll ? "收起" : `显示 ${current.length} 个`}
        </button>
      ) : null}
    </section>
  );
}
