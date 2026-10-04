"use client";

import { useState } from "react";
import { useScrollMemory } from "../../hooks/useScrollMemory";
import { errorMessage } from "../../lib/api";
import { joinNames } from "../../lib/format";
import { matchesFilter } from "../../lib/skill-model";
import { PlusIcon, RefreshIcon } from "../icons";
import { useData } from "../providers/DataProvider";
import { useNav } from "../providers/NavProvider";
import { useToast } from "../providers/ToastProvider";
import { AgentAvatar, ExpertAvatar } from "../ui/Avatar";
import { Loading, SectionHeading, TopBar } from "../ui/basics";
import { AgentCard } from "./home/AgentCard";
import { HomeNotes } from "./home/HomeNotes";

export function RescanButton() {
  const { refresh } = useData();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn ghost"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await refresh(true);
          toast.show("扫描完成");
        } catch (error) {
          toast.show(errorMessage(error, "扫描失败。"), { tone: "error" });
        } finally {
          setBusy(false);
        }
      }}
    >
      <RefreshIcon className={busy ? "spin" : ""} />
      {busy ? "正在扫描…" : "重新扫描"}
    </button>
  );
}

function SharedFolders() {
  const { scan, primary, agentName, views } = useData();
  const roots = (scan.data?.sharedRoots || []).filter(
    (root) => root.agentIds.length > 1 && root.agentIds.some((id) => primary.includes(id)),
  );
  const linked = views.filter((view) =>
    view.skill.instances.some(
      (instance) => primary.includes(instance.agentId) && (instance.sharedWith || []).some((id) => primary.includes(id) && id !== instance.agentId),
    ),
  ).length;
  if (!roots.length && !linked) return null;
  return (
    <div className="shared-list">
      {roots.map((root) => (
        <div className="shared" key={root.realPathId}>
          <div className="pair" aria-hidden="true">
            {root.agentIds.slice(0, 3).map((id, index) => (
              <span key={id} className="pair-item">
                {index ? <span className="link" /> : null}
                <AgentAvatar id={id} size="md" />
              </span>
            ))}
          </div>
          <p>
            <b>{joinNames(root.agentIds.map(agentName))} 共用一个技能文件夹</b>：<code>{root.realPath}</code>
            {root.managedBy ? `（由 ${root.managedBy} 管理）` : ""}。放进这里的技能它们都能用，Skill Control 不会重复安装。
          </p>
        </div>
      ))}
      {linked && primary.length > 1 ? (
        <div className="shared">
          <div className="pair" aria-hidden="true">
            {primary.slice(0, 2).map((id, index) => (
              <span key={id} className="pair-item">
                {index ? <span className="link" /> : null}
                <AgentAvatar id={id} size="md" />
              </span>
            ))}
          </div>
          <p>
            <b>{linked} 个技能在常用 Agent 之间指向同一个文件夹</b>（软链接）。改一处，两边一起生效。
          </p>
        </div>
      ) : null}
    </div>
  );
}

function ExpertsTeaser() {
  const { capabilities } = useData();
  const { go } = useNav();
  const workbuddy = capabilities.data?.products.find((product) => product.id === "workbuddy");
  if (!workbuddy?.items.length) return null;
  const mine = workbuddy.items.filter((item) => item.origin === "mine");
  const market = workbuddy.items.filter((item) => item.origin === "market");
  return (
    <>
      <SectionHeading title="其他软件里的专家" note="WorkBuddy 特有" />
      <div className="note">
        <ExpertAvatar capability={mine[0] || workbuddy.items[0]} />
        <div>
          <b>WorkBuddy 里有 {workbuddy.items.length} 个专家和专家团</b>
          <span>
            {mine.length ? `其中 ${mine.length} 个是你做的（${joinNames(mine.map((item) => item.displayName))}），` : ""}
            {market.length} 个从专家市场添加。可以查看角色设定、成员分工和依赖的技能。
          </span>
        </div>
        <button type="button" className="btn sm" onClick={() => go("experts")}>
          查看
        </button>
      </div>
    </>
  );
}

export function HomePage() {
  const { scan, primary, agentName, agents, views, capabilities } = useData();
  const { go, setImportOpen } = useNav();
  const scrollRef = useScrollMemory<HTMLDivElement>("home");
  const others = agents.filter((agent) => agent.available && agent.skillCount > 0 && !primary.includes(agent.id));
  const workbuddyExperts = capabilities.data?.products.find((product) => product.id === "workbuddy")?.items.length || 0;
  const onlyFirst = primary.length > 1 ? views.filter((view) => matchesFilter(view, `only:${primary[0]}`, primary)).length : 0;

  return (
    <section className="page" aria-labelledby="page-title">
      <TopBar
        title={<span id="page-title">概览</span>}
        sub={primary.length ? `常用 Agent：${joinNames(primary.map(agentName))}` : "正在读取本机的 Agent…"}
      >
        <RescanButton />
        <button type="button" className="btn" onClick={() => setImportOpen(true)}>
          <PlusIcon />
          导入技能
        </button>
      </TopBar>
      <div className="scroll" ref={scrollRef}>
        {!scan.data ? (
          <div className="home-loading">
            <p className="lead">正在读取本机的技能和 Agent…</p>
            <Loading rows={4} />
          </div>
        ) : (
          <>
            <div className="agents-grid">
              {primary.map((id) => (
                <AgentCard key={id} agentId={id} />
              ))}
            </div>
            <SharedFolders />
            <SectionHeading title="值得看一眼" note="只看常用 Agent" />
            <HomeNotes />
            <ExpertsTeaser />
            {others.length ? (
              <>
                <SectionHeading title="其他已安装的 Agent" note="只显示，不会提醒你安装" />
                <div className="others">
                  {others.map((agent) => (
                    <button key={agent.id} type="button" className="chip-agent" onClick={() => go("agent", { agentId: agent.id })}>
                      <AgentAvatar id={agent.id} />
                      {agent.name}
                      <em>
                        {agent.skillCount} 个技能
                        {agent.id === "workbuddy" && workbuddyExperts ? ` · ${workbuddyExperts} 个专家` : ""}
                      </em>
                    </button>
                  ))}
                </div>
              </>
            ) : null}
            {onlyFirst ? (
              <p className="footnote">
                只在 {agentName(primary[0])} 里有的技能有 {onlyFirst} 个。想让 {agentName(primary[1])} 也用上，到“技能”页点一下对应的圆点就行。
              </p>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
