"use client";

import { useState } from "react";
import { invalidateResources } from "../../../hooks/useResource";
import { api, errorMessage } from "../../../lib/api";
import { formatRelative } from "../../../lib/format";
import {
  autoLinkMessage,
  gapSentence,
  needsConsent,
  pendingRows,
  primaryLibraryAgents,
  type AutoLink,
  type AutoLinkScope,
  type LibraryData,
} from "../../../lib/library";
import { consentRequest } from "../../../lib/library-review";
import { CheckIcon, InfoIcon, WarnIcon } from "../../icons";
import { useData } from "../../providers/DataProvider";
import { useNav } from "../../providers/NavProvider";
import { useToast } from "../../providers/ToastProvider";
import { useNow } from "../../../hooks/useNow";
import { Segmented, Switch } from "../../ui/basics";

const SCOPES: { id: AutoLinkScope; label: string }[] = [
  { id: "primary", label: "常用 Agent" },
  { id: "all", label: "所有已安装的 Agent" },
];

export const CATCH_UP_REQUEST = { action: "catch-up" as const, title: "补齐接入" };

/** 自动接入 on/off and scope: a config write with 撤销 in the toast. */
function useAutoLinkWriter() {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const save = async (next: { enabled: boolean; scope: AutoLinkScope }, previous: AutoLink | null, message: string) => {
    if (saving) return;
    setSaving(true);
    try {
      await api.setAutoLink(next);
      toast.show(message, {
        action: previous
          ? {
              label: "撤销",
              run: async () => {
                await api.setAutoLink({ enabled: previous.enabled, scope: previous.scope });
                await invalidateResources("library");
                toast.show("已撤销");
              },
            }
          : undefined,
      });
    } catch (error) {
      toast.show(errorMessage(error, "没有保存成功。"), { tone: "error" });
    } finally {
      setSaving(false);
      void invalidateResources("library");
    }
  };
  return { save, saving };
}

/**
 * The truthful header of the 技能库 page: who can't see how many library skills, what fixes
 * it (补齐接入, Hermes consent), and the 自动接入 switch with its scope.
 */
export function LibraryStatus({ data }: { data: LibraryData }) {
  const { agentName, primary: appPrimary } = useData();
  const { setLibraryRequest } = useNav();
  const now = useNow();
  const { save, saving } = useAutoLinkWriter();
  const primary = primaryLibraryAgents(data, appPrimary);
  const sentence = gapSentence(data, primary, agentName);
  const autoLink = data.autoLink;
  const scopeIds = autoLink?.scope === "all" ? data.agents.map((agent) => agent.agentId) : primary;
  const pending = pendingRows(autoLink, scopeIds);
  const pendingTotal = pending.reduce((sum, row) => sum + row.count, 0);
  const consent = needsConsent(data, scopeIds);
  const scopeText = autoLink?.scope === "all" ? "所有已安装的 Agent" : "常用 Agent";
  const lastRun = autoLink?.lastRun?.at && autoLink.lastRun.items.length ? autoLink.lastRun : null;

  const toggle = () => {
    if (!autoLink) return;
    const enabled = !autoLink.enabled;
    void save(
      { enabled, scope: autoLink.scope },
      autoLink,
      enabled ? `已开启自动接入：新进库的技能会接入${scopeText}` : "已关闭自动接入，新进库的技能要手动接入",
    );
  };
  const setScope = (scope: AutoLinkScope) => {
    if (!autoLink || scope === autoLink.scope) return;
    void save({ enabled: autoLink.enabled, scope }, autoLink, `自动接入范围改为：${scope === "all" ? "所有已安装的 Agent" : "常用 Agent"}`);
  };

  return (
    <section className={`lib-status ${sentence.ok ? "ok" : sentence.onlySkipped ? "calm" : "gap"}`} aria-label="技能库现状">
      <div className="lib-status-main">
        <span className={`ic ${sentence.ok ? "ok" : sentence.onlySkipped ? "info" : "warn"}`} aria-hidden="true">
          {sentence.ok ? <CheckIcon /> : sentence.onlySkipped ? <InfoIcon /> : <WarnIcon />}
        </span>
        <div className="lib-status-text">
          <b>{sentence.text}</b>
          {pendingTotal ? (
            <span>
              {autoLink?.enabled ? "这些是开启自动接入之前就有的缺口。" : ""}补齐接入会接入
              {pending.map((row, index) => (
                <span key={row.agentId}>
                  {index ? "、" : " "}
                  {agentName(row.agentId)} {row.count} 个
                </span>
              ))}
              。
            </span>
          ) : null}
          {consent.length ? (
            <span>
              {consent.map((agent) => agent.name).join("、")} 要在配置里加一次技能库目录才能看到，需要你同意。
            </span>
          ) : null}
          {sentence.note ? <span className="muted">{sentence.note}</span> : null}
        </div>
        <div className="lib-status-acts">
          {consent.map((agent) => (
            <button key={agent.agentId} type="button" className="btn sm" onClick={() => setLibraryRequest(consentRequest(agent.agentId, agent.name))}>
              让 {agent.name} 读取技能库
            </button>
          ))}
          {autoLink && !autoLink.enabled ? (
            <button type="button" className={`btn sm ${pendingTotal ? "" : "primary"}`} disabled={saving} onClick={toggle}>
              开启自动接入
            </button>
          ) : null}
          {pendingTotal ? (
            <button type="button" className="btn sm primary" onClick={() => setLibraryRequest(CATCH_UP_REQUEST)}>
              补齐接入
            </button>
          ) : null}
        </div>
      </div>
      {autoLink ? (
        <div className="lib-auto">
          <Switch checked={autoLink.enabled} label="自动接入" disabled={saving} onChange={toggle} />
          <div className="lib-auto-text">
            <b>自动接入</b>
            <span>
              {autoLink.enabled
                ? `新进库的技能会自动接入${scopeText}；它们自己另有同名副本的不动，你取消接入的也不会再接回。`
                : "已关闭：新进库的技能要在这里或技能详情里手动接入。"}
            </span>
            {lastRun ? (
              <span className="muted">
                {now ? `${formatRelative(lastRun.at, now)}：` : ""}
                {autoLinkMessage(lastRun.items, agentName)}
              </span>
            ) : null}
          </div>
          <Segmented items={SCOPES} value={autoLink.scope} onChange={setScope} label="自动接入范围" />
        </div>
      ) : null}
    </section>
  );
}
