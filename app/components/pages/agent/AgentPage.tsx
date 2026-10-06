"use client";

import { useCallback, useState } from "react";
import { useScrollMemory } from "../../../hooks/useScrollMemory";
import { MAX_PRIMARY_AGENTS } from "../../../lib/agents";
import { errorMessage } from "../../../lib/api";
import { joinNames } from "../../../lib/format";
import { useData } from "../../providers/DataProvider";
import { useNav } from "../../providers/NavProvider";
import { useToast } from "../../providers/ToastProvider";
import { AgentAvatar } from "../../ui/Avatar";
import { EmptyState, Loading, Tabs, TopBar } from "../../ui/basics";
import { activityLine } from "../home/AgentCard";
import { AgentFiles } from "./AgentFiles";
import { AgentOverview } from "./AgentOverview";
import { AgentTools } from "./AgentTools";
import { AgentUsage } from "./AgentUsage";
import type { UsageSection } from "./AgentUsageSections";

type Tab = "overview" | "files" | "tools" | "usage";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "概览" },
  { id: "files", label: "人格与记忆文件" },
  { id: "tools", label: "可用工具" },
  { id: "usage", label: "使用数据" },
];

const AGENT_NOTES: Record<string, string> = {
  hermes: "Hermes 会自动归档长期不用的技能；被归档的技能只显示，不参与对比。使用次数来自 Hermes 自己记录的 .usage.json。",
  qclaw: "QClaw 是腾讯基于 OpenClaw 的发行版。它的技能由 QClaw 远程同步和清理，Skill Control 只读。",
  openclaw: "OpenClaw 的技能目录可能由其他工具写入；指向技能根目录之外的软链接，OpenClaw 不会加载。",
};

export function AgentPage({ agentId }: { agentId: string }) {
  const { agentsById, scan, primary, config, updateConfig, savingConfig, agentName, activityById } = useData();
  const { go } = useNav();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("overview");
  // A 概览 card asks for a section of 使用数据; the tab scrolls to it once drawn.
  const [focus, setFocus] = useState<UsageSection | null>(null);
  const openUsage = (section: UsageSection) => {
    setFocus(section);
    setTab("usage");
  };
  const clearFocus = useCallback(() => setFocus(null), []);
  const [saving, setSaving] = useState(false);
  const scrollRef = useScrollMemory<HTMLDivElement>(`agent:${agentId}`);
  const agent = agentsById.get(agentId);
  const isPrimary = primary.includes(agentId);

  const togglePrimary = async () => {
    if (!config.data) return;
    const next = isPrimary ? primary.filter((id) => id !== agentId) : [...primary, agentId];
    if (!next.length) {
      toast.show("至少保留一个常用 Agent");
      return;
    }
    if (next.length > MAX_PRIMARY_AGENTS) {
      toast.show(`最多选 ${MAX_PRIMARY_AGENTS} 个常用 Agent，先在设置里取消一个`);
      return;
    }
    setSaving(true);
    try {
      const { previous } = await updateConfig({ primaryAgentIds: next });
      toast.show(`常用 Agent：${joinNames(next.map(agentName))}`, {
        action: { label: "撤销", run: async () => void (await updateConfig(previous)) },
      });
    } catch (error) {
      toast.show(errorMessage(error, "保存失败。"), { tone: "error" });
    } finally {
      setSaving(false);
    }
  };

  if (!scan.data) {
    return (
      <section className="page">
        <TopBar title={agentName(agentId)} />
        <div className="scroll">
          <Loading rows={6} />
        </div>
      </section>
    );
  }
  if (!agent) {
    return (
      <section className="page">
        <TopBar title={agentName(agentId)} />
        <div className="scroll">
          <EmptyState title="没有找到这个 Agent" action={<button type="button" className="btn" onClick={() => go("home")}>回到概览</button>}>
            它可能已经卸载，或者被移出了配置。
          </EmptyState>
        </div>
      </section>
    );
  }

  const summary = [
    agent.productVersion ? `版本 ${agent.productVersion}` : "",
    `${agent.skillCount} 个技能`,
    activityLine(activityById.get(agent.id)),
    agent.managedBy?.length ? `由 ${joinNames(agent.managedBy)} 写入` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section className="page agent-page" aria-labelledby="page-title">
      {/* One header: avatar, name with its status, the summary line and the actions. */}
      <TopBar
        leading={<AgentAvatar id={agent.id} size="lg" />}
        title={
          <>
            <span id="page-title">{agent.name}</span>
            {isPrimary ? <span className="tag">常用</span> : <span className="tag mute">非常用</span>}
            {agent.refuseInstall ? <span className="tag info">只读</span> : null}
          </>
        }
        sub={summary}
      >
        <button type="button" className="btn" onClick={() => go("skills", { filter: isPrimary ? `only:${agent.id}` : `agent:${agent.id}` })}>
          查看它的技能
        </button>
        <button type="button" className="btn ghost" disabled={saving || savingConfig} onClick={togglePrimary}>
          {isPrimary ? "不再设为常用" : "设为常用"}
        </button>
      </TopBar>
      <div className="scroll" ref={scrollRef}>
        {AGENT_NOTES[agent.id] || agent.refuseInstall ? (
          <p className="safe-note info">{agent.refuseInstall || AGENT_NOTES[agent.id]}</p>
        ) : null}
        <Tabs tabs={TABS} value={tab} onChange={setTab} label={`${agent.name} 详情`} idBase={`agent-${agent.id}`} />
        <div role="tabpanel" aria-labelledby={`agent-${agent.id}-tab-${tab}`} className="agent-panel">
          {tab === "overview" ? <AgentOverview agent={agent} onOpenUsage={openUsage} /> : null}
          {tab === "files" ? <AgentFiles agentId={agent.id} agentName={agent.name} /> : null}
          {tab === "tools" ? <AgentTools agentId={agent.id} agentName={agent.name} /> : null}
          {tab === "usage" ? <AgentUsage agentId={agent.id} agentName={agent.name} focus={focus} onFocused={clearFocus} /> : null}
        </div>
      </div>
    </section>
  );
}
