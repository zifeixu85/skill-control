"use client";

import { useScrollMemory } from "../../hooks/useScrollMemory";
import { errorMessage } from "../../lib/api";
import type { Capability } from "../../lib/types";
import { capabilityKindLabel } from "../drawers/ExpertDrawer";
import { useData } from "../providers/DataProvider";
import { useNav } from "../providers/NavProvider";
import { AgentAvatar, ExpertAvatar } from "../ui/Avatar";
import { EmptyState, Loading, SectionHeading, TopBar } from "../ui/basics";

export function ExpertCard({ capability }: { capability: Capability }) {
  const { openDrawer } = useNav();
  const tags: { label: string; tone: string }[] = [{ label: capabilityKindLabel(capability), tone: "mute" }];
  if (capability.skillCount) tags.push({ label: `${capability.skillCount} 个技能`, tone: "mute" });
  if (capability.used?.count) tags.push({ label: `用过 ${capability.used.count} 次`, tone: "" });
  if (capability.inUse) tags.push({ label: "使用中", tone: "" });
  if (capability.origin === "mine" && capability.packaged) tags.push({ label: "已打包，可分发", tone: "info" });
  if (capability.model) tags.push({ label: capability.model, tone: "mute" });
  return (
    <button type="button" className="pcard" onClick={() => openDrawer({ kind: "expert", id: capability.id })}>
      <div className="pcard-h">
        <ExpertAvatar capability={capability} />
        <div className="pcard-name">
          <b>{capability.displayName || capability.name}</b>
          <span>{capability.profession || capability.productName}</span>
        </div>
        {capability.version ? (
          <span className="state">
            <span className="tag mute">v{capability.version}</span>
          </span>
        ) : null}
      </div>
      <p>{capability.description || "没有介绍"}</p>
      <div className="inside">
        {tags.map((tag) => (
          <span key={tag.label} className={`tag ${tag.tone}`}>
            {tag.label}
          </span>
        ))}
      </div>
    </button>
  );
}

function Group({ title, note, items, mine, agentId }: { title: string; note: string; items: Capability[]; mine?: boolean; agentId?: string }) {
  if (!items.length) return null;
  return (
    <>
      <SectionHeading
        title={
          <>
            {agentId ? <AgentAvatar id={agentId} size="xs" /> : null}
            {title}
          </>
        }
        note={note}
      />
      <div className={mine ? "mine" : "pgrid"}>
        {items.map((item) => (
          <ExpertCard key={item.id} capability={item} />
        ))}
      </div>
    </>
  );
}

export function ExpertsPage() {
  const { capabilities } = useData();
  const scrollRef = useScrollMemory<HTMLDivElement>("experts");
  const products = capabilities.data?.products || [];
  const workbuddy = products.find((product) => product.id === "workbuddy");
  const items = workbuddy?.items || [];
  const mine = items.filter((item) => item.origin === "mine");
  const market = items.filter((item) => item.origin !== "mine");
  const others = products.filter((product) => product.id !== "workbuddy" && product.items.length);

  return (
    <section className="page" aria-labelledby="page-title">
      <TopBar
        title={<span id="page-title">专家与 Agent</span>}
        sub="专家 = 角色设定 + 依赖的技能 + 开场提示。WorkBuddy 的专家和专家团、Hermes 的 Profile、OpenClaw 的 Agent 都在这里"
      />
      <div className="scroll" ref={scrollRef}>
        {capabilities.status === "error" && !capabilities.data ? (
          <EmptyState tone="error" title="读取专家失败">
            {errorMessage(capabilities.error)}
          </EmptyState>
        ) : !capabilities.data ? (
          <Loading label="正在读取专家…" rows={6} />
        ) : !items.length && !others.length ? (
          <EmptyState title="没有找到专家或 Agent 配置">WorkBuddy、Hermes、OpenClaw 等产品的专家会显示在这里。</EmptyState>
        ) : (
          <>
            <Group title="我做的专家" note={`${mine.length} 个 · 来自 WorkBuddy 的“我的专家”`} items={mine} mine agentId="workbuddy" />
            <Group
              title="从专家市场添加"
              note={`${market.length} 个已下载到本机${workbuddy?.catalogCount ? ` · 专家中心共 ${workbuddy.catalogCount} 个` : ""}`}
              items={market}
              agentId="workbuddy"
            />
            {others.map((product) => (
              <Group
                key={product.id}
                title={product.name}
                note={`${product.items.length} 个${product.kindLabel}${product.sourcePath ? ` · ${product.sourcePath}` : ""}`}
                items={product.items}
                agentId={product.id}
              />
            ))}
            <p className="footnote">“用过”来自 WorkBuddy 本地会话记录。专家的启用和对话在各自的产品里完成，这里只读。</p>
          </>
        )}
      </div>
    </section>
  );
}
