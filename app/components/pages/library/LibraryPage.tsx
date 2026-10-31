"use client";

import { isUnsupported, useResource } from "../../../hooks/useResource";
import { usePageMemory, useReturnHighlight } from "../../../hooks/usePageMemory";
import { useScrollMemory } from "../../../hooks/useScrollMemory";
import { api, errorMessage } from "../../../lib/api";
import { gapIssues, primaryLibraryAgents, type GapIssue, type LibraryEntry, type LibraryIssue } from "../../../lib/library";
import type { SortFields, SortKey } from "../../../lib/sort";
import { SortControl, useSortedList } from "../../ui/SortControl";
import { consentRequest, scopeForIssue } from "../../../lib/library-review";
import { InfoIcon, WarnIcon } from "../../icons";
import { useData } from "../../providers/DataProvider";
import { EmptyState, Loading, SectionHeading, TopBar } from "../../ui/basics";
import { ItemText } from "../../ui/Item";
import { AgentStrip, EntriesTable } from "./LibraryParts";
import { LibraryStatus } from "./LibraryStatus";
import { TrashList } from "./TrashList";
import { useNav } from "../../providers/NavProvider";
import type { PlanRequest } from "./PlanReview";

export const LIBRARY_KEY = "library";

const BATCH: PlanRequest = { action: "batch", title: "一键整理技能库" };
const entryFields = (entry: LibraryEntry): SortFields => ({ name: entry.name, installedAt: entry.installedAt });
const ENTRY_SORTS: SortKey[] = ["installed", "name"];
const NO_ENTRIES: LibraryEntry[] = [];

export function LibraryPage() {
  const library = useResource(LIBRARY_KEY, () => api.library());
  const { primary: appPrimary, agentName } = useData();
  const scrollRef = useScrollMemory<HTMLDivElement>("library");
  const { setLibraryRequest } = useNav();
  const review = () => setLibraryRequest(BATCH);
  // Each 需要注意 entry opens the tidy-up narrowed to just its items, when that is possible.
  const reviewIssue = (issue: LibraryIssue) => {
    const scope = scopeForIssue(issue);
    setLibraryRequest(scope ? { action: "batch", title: `整理：${issue.title}`, scope } : BATCH);
  };
  // Session memory: 查看 a skill → back keeps the same columns, scroll and highlights the row.
  const [allAgents, setAllAgents] = usePageMemory<boolean>("library:all-agents", false);
  const data = library.data;
  useReturnHighlight("library", Boolean(data));
  const { sorted: entries, key: sortKey, options: sortOptions, setKey: setSortKey } = useSortedList("library", data?.entries || NO_ENTRIES, entryFields, ENTRY_SORTS);
  const shownAgents = data ? data.agents.filter((agent) => allAgents || !agent.collapsed) : [];
  const gaps = data ? gapIssues(data, primaryLibraryAgents(data, appPrimary), agentName) : [];
  const fixGap = (gap: GapIssue) => {
    if (gap.fix === "consent") setLibraryRequest(consentRequest(gap.agentId, agentName(gap.agentId)));
    else if (gap.fix === "catch-up") setLibraryRequest({ action: "catch-up", agents: [gap.agentId], title: `补齐接入：${agentName(gap.agentId)}` });
    else review();
  };
  const issueCount = (data?.issues.length || 0) + gaps.length;
  const hiddenAgents = data ? data.agents.filter((agent) => agent.collapsed).length : 0;

  return (
    <section className="page" aria-labelledby="page-title">
      <TopBar
        title={<span id="page-title">技能库</span>}
        sub="技能库 = ~/.agents/skills。技能只存这一份：有的 Agent 会自动读取技能库，有的需要逐个接入或加一次额外目录"
      >
        <button type="button" className="btn primary" disabled={!data} onClick={review}>
          一键整理
        </button>
      </TopBar>
      <div className="scroll" ref={scrollRef}>
        {isUnsupported(library.error) ? (
          <EmptyState title="本地服务还没有提供技能库">更新 Skill Control 后可以把各 Agent 的技能整理到 ~/.agents/skills。</EmptyState>
        ) : library.status === "error" && !data ? (
          <EmptyState tone="error" title="读取技能库失败">
            {errorMessage(library.error)}
          </EmptyState>
        ) : !data ? (
          <Loading label="正在检查技能库…" rows={6} />
        ) : (
          <>
            <div className="lib-root">
              <code>{data.root}</code>
              {data.realRoot && data.realRoot !== data.root ? <span>实际位置 {data.realRoot}</span> : null}
              {data.owner ? (
                <span>
                  {data.owner.manager ? `由 ${data.owner.manager} 管理` : "是一个链接"}
                  {data.owner.appInstalled === false ? "（管理它的应用已经不在了）" : ""}
                </span>
              ) : null}
              {!data.exists ? <span className="tag warn">还没有创建</span> : null}
              <span className="muted">{data.entries.length} 个技能</span>
            </div>
            <LibraryStatus data={data} />
            <SectionHeading title="各 Agent 怎么接入技能库" note={hiddenAgents && !allAgents ? `另有 ${hiddenAgents} 个不常用的 Agent` : undefined} />
            <AgentStrip data={data} agents={shownAgents} />
            {hiddenAgents ? (
              <button type="button" className="btn sm ghost" onClick={() => setAllAgents(!allAgents)}>
                {allAgents ? "只看常用 Agent" : `显示全部 ${data.agents.length} 个 Agent`}
              </button>
            ) : null}
            <SectionHeading title="需要注意" note={issueCount ? `${issueCount} 项` : "没有问题"} />
            {issueCount ? (
              <div className="notes">
                {gaps.map((gap) => (
                  <div className="note" key={`gap-${gap.agentId}`}>
                    <span className="ic warn">
                      <WarnIcon />
                    </span>
                    <ItemText
                      title={gap.title}
                      meta={`${gap.names.slice(0, 8).join("、")}${gap.names.length > 8 ? ` 等 ${gap.names.length} 个` : ""}`}
                      mono
                      desc={gap.detail || null}
                      lines={2}
                    />
                    <div className="it-acts">
                      {gap.fix ? (
                        <button type="button" className="btn sm" onClick={() => fixGap(gap)}>
                          {gap.fix === "consent" ? "同意读取" : gap.fix === "catch-up" ? "补齐接入" : "整理"}
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
                {data.issues.map((issue) => (
                  <div className="note" key={issue.id + (issue.agentId || "")}>
                    <span className={`ic ${issue.severity === "error" ? "danger" : issue.severity === "warn" ? "warn" : "info"}`}>
                      {issue.severity === "info" ? <InfoIcon /> : <WarnIcon />}
                    </span>
                    <ItemText
                      title={issue.title}
                      meta={issue.names.length ? `${issue.names.slice(0, 8).join("、")}${issue.names.length > 8 ? ` 等 ${issue.names.length} 个` : ""}` : null}
                      mono
                      desc={issue.detail || null}
                      lines={2}
                    />
                    <div className="it-acts">
                      <button type="button" className="btn sm" onClick={() => reviewIssue(issue)}>
                        整理
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted small">没有需要注意的问题。</p>
            )}
            <SectionHeading
              title="库里的技能"
              note="圆点 = 这个 Agent 能否看到；把鼠标放上去看原因"
              action={<SortControl value={sortKey} options={sortOptions} onChange={setSortKey} />}
            />
            {entries.length ? <EntriesTable entries={entries} agents={shownAgents} /> : <p className="muted small">技能库里还没有技能。</p>}
            <div className="legend lib-legend">
              <span><i className="vis visible" />可见</span>
              <span><i className="vis hidden" />被产品隐藏</span>
              <span><i className="vis duplicate" />重复出现</span>
              <span><i className="vis private-copy" />自己另有一份</span>
              <span><i className="vis missing" />看不到</span>
            </div>
            <SectionHeading title="回收站" note="移出技能库、从 Agent 移除或撤销时移走的技能，都可以放回原位" />
            <TrashList />
          </>
        )}
      </div>
    </section>
  );
}
