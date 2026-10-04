"use client";

import { useState } from "react";
import { isUnsupported, useResource } from "../../../hooks/useResource";
import { useScrollMemory } from "../../../hooks/useScrollMemory";
import { api, errorMessage } from "../../../lib/api";
import type { LibraryIssue } from "../../../lib/library";
import { scopeForIssue } from "../../../lib/library-review";
import { CheckIcon, WarnIcon } from "../../icons";
import { EmptyState, Loading, SectionHeading, TopBar } from "../../ui/basics";
import { AgentStrip, EntriesTable } from "./LibraryParts";
import { TrashList } from "./TrashList";
import { useNav } from "../../providers/NavProvider";
import type { PlanRequest } from "./PlanReview";

export const LIBRARY_KEY = "library";

const BATCH: PlanRequest = { action: "batch", title: "一键整理技能库" };

export function LibraryPage() {
  const library = useResource(LIBRARY_KEY, () => api.library());
  const scrollRef = useScrollMemory<HTMLDivElement>("library");
  const { setLibraryRequest } = useNav();
  const review = () => setLibraryRequest(BATCH);
  // Each 需要注意 entry opens the tidy-up narrowed to just its items, when that is possible.
  const reviewIssue = (issue: LibraryIssue) => {
    const scope = scopeForIssue(issue);
    setLibraryRequest(scope ? { action: "batch", title: `整理：${issue.title}`, scope } : BATCH);
  };
  const [allAgents, setAllAgents] = useState(false);
  const data = library.data;
  const shownAgents = data ? data.agents.filter((agent) => allAgents || !agent.collapsed) : [];
  const hiddenAgents = data ? data.agents.filter((agent) => agent.collapsed).length : 0;

  return (
    <section className="page" aria-labelledby="page-title">
      <TopBar
        title={<span id="page-title">技能库</span>}
        sub="技能库 = ~/.agents/skills。装一次，常用 Agent 都能用；每个 Agent 按自己的方式读取它"
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
            <SectionHeading title="各 Agent 怎么读取技能库" note={hiddenAgents && !allAgents ? `另有 ${hiddenAgents} 个不常用的 Agent` : undefined} />
            <AgentStrip data={data} agents={shownAgents} />
            {hiddenAgents ? (
              <button type="button" className="btn sm ghost" onClick={() => setAllAgents((value) => !value)}>
                {allAgents ? "只看常用 Agent" : `显示全部 ${data.agents.length} 个 Agent`}
              </button>
            ) : null}
            <SectionHeading title="需要注意" note={data.issues.length ? `${data.issues.length} 项` : "没有问题"} />
            {data.issues.length ? (
              <div className="notes">
                {data.issues.map((issue) => (
                  <div className="note" key={issue.id + (issue.agentId || "")}>
                    <span className={`ic ${issue.severity === "error" ? "danger" : issue.severity === "warn" ? "warn" : "ok"}`}>
                      {issue.severity === "info" ? <CheckIcon /> : <WarnIcon />}
                    </span>
                    <div>
                      <b>{issue.title}</b>
                      <span>
                        {issue.detail}
                        {issue.names.length ? `（${issue.names.slice(0, 6).join("、")}${issue.names.length > 6 ? " 等" : ""}）` : ""}
                      </span>
                    </div>
                    <button type="button" className="btn sm" onClick={() => reviewIssue(issue)}>
                      整理
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted small">每个常用 Agent 都能看到技能库里的技能。</p>
            )}
            <SectionHeading title="库里的技能" note="圆点 = 这个 Agent 能否看到；把鼠标放上去看原因" />
            {data.entries.length ? <EntriesTable entries={data.entries} agents={shownAgents} /> : <p className="muted small">技能库里还没有技能。</p>}
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
