"use client";

import { useMemo } from "react";
import { usePersistent } from "../../hooks/usePersistent";
import { useScrollMemory } from "../../hooks/useScrollMemory";
import { sortItems, type SortFields, type SortKey } from "../../lib/sort";
import { persistentStore } from "../../lib/storage";
import { errorMessage } from "../../lib/api";
import { countChip, type ChipSpec } from "../../lib/chips";
import type { Capability } from "../../lib/types";
import { capabilityKindLabel } from "../drawers/ExpertDrawer";
import { useData } from "../providers/DataProvider";
import { useNav } from "../providers/NavProvider";
import { AgentAvatar, ExpertAvatar } from "../ui/Avatar";
import { EmptyState, Loading, SectionHeading, TopBar } from "../ui/basics";
import { ChipRow, ItemText } from "../ui/Item";
import { SortControl, useSortedList } from "../ui/SortControl";

/** Status (使用中, 已打包) → kind (专家, model) → counts (技能, 用过 N 次). */
export function expertChips(capability: Capability): ChipSpec[] {
  const chips: ChipSpec[] = [];
  if (capability.inUse) chips.push({ id: "in-use", kind: "status", text: "使用中" });
  if (capability.origin === "mine" && capability.packaged) chips.push({ id: "packaged", kind: "status", tone: "info", text: "已打包，可分发" });
  chips.push({ id: "kind", kind: "kind", text: capabilityKindLabel(capability) });
  if (capability.model) chips.push({ id: "model", kind: "kind", text: capability.model, title: capability.model });
  if (capability.skillCount) chips.push(countChip("skills", capability.skillCount, " 个技能"));
  if (capability.used?.count) chips.push(countChip("used", capability.used.count, " 次", "用过 "));
  return chips;
}

export function ExpertCard({ capability }: { capability: Capability }) {
  const { openDrawer } = useNav();
  const chips = expertChips(capability);
  const status = chips[0]?.kind === "status" ? chips[0] : null;
  return (
    <button type="button" className="pcard card" data-detail-trigger="" onClick={() => openDrawer({ kind: "expert", id: capability.id })}>
      <div className="card-head">
        <ExpertAvatar capability={capability} />
        <ItemText
          title={capability.displayName || capability.name}
          meta={[capability.profession || capability.productName, capability.version ? `v${capability.version}` : ""].filter(Boolean).join(" · ")}
        />
        {status ? <span className={`tag card-status ${status.tone || ""}`}>{status.text}</span> : <span />}
      </div>
      <p className="card-desc">{capability.description || "没有介绍"}</p>
      <ChipRow className="card-foot" chips={status ? chips.slice(1) : chips} max={4} />
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

const fields = (capability: Capability): SortFields => ({
  name: capability.displayName || capability.name,
  uses: capability.used?.count ?? null,
  lastUsedAt: capability.lastUsedAt || capability.used?.lastUsedAt || null,
  installedAt: capability.createdAt || null,
  updatedAt: capability.updatedAt || capability.modifiedAt || null,
});
const EXPERT_SORTS: SortKey[] = ["uses", "used", "installed", "name"];

export const expertsTabStore = persistentStore<string>("experts-tab", "all", (value) => /^[a-z0-9._-]{1,64}$/i.test(value));

export function ExpertsPage() {
  const { capabilities } = useData();
  const scrollRef = useScrollMemory<HTMLDivElement>("experts");
  const [tabChoice, setTab] = usePersistent(expertsTabStore);
  const products = (capabilities.data?.products || []).filter((product) => product.items.length);
  const allItems = useMemo(() => products.flatMap((product) => product.items), [products]);
  const { key, options, setKey } = useSortedList("experts", allItems, fields, EXPERT_SORTS);
  const tab = tabChoice === "all" || products.some((product) => product.id === tabChoice) ? tabChoice : "all";
  const shown = tab === "all" ? products : products.filter((product) => product.id === tab);
  const sorted = (items: Capability[]) => sortItems(items, key, fields);

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
        ) : !products.length ? (
          <EmptyState title="没有找到专家或 Agent 配置">WorkBuddy、Hermes、OpenClaw 等产品的专家会显示在这里。</EmptyState>
        ) : (
          <>
            <div className="sticky-bar" role="toolbar" aria-label="按产品筛选和排序">
              <div className="tabbar" role="group" aria-label="按产品筛选">
                {[{ id: "all", name: "全部", count: allItems.length }, ...products.map((product) => ({ id: product.id, name: product.name, count: product.items.length }))].map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={tab === item.id}
                    className={`tab-chip ${tab === item.id ? "on" : ""}`}
                    onClick={() => setTab(item.id)}
                  >
                    {item.id !== "all" ? <AgentAvatar id={item.id} size="xs" /> : null}
                    {item.name}
                    <em>{item.count}</em>
                  </button>
                ))}
              </div>
              <SortControl value={key} options={options} onChange={setKey} />
            </div>
            {shown.map((product) =>
              product.id === "workbuddy" ? (
                <WorkBuddyGroups key={product.id} items={sorted(product.items)} catalogCount={product.catalogCount} />
              ) : (
                <Group
                  key={product.id}
                  title={product.name}
                  note={`${product.items.length} 个${/^[A-Za-z]/u.test(product.kindLabel) ? " " : ""}${product.kindLabel}${product.sourcePath ? ` · ${product.sourcePath}` : ""}`}
                  items={sorted(product.items)}
                  agentId={product.id}
                />
              ),
            )}
            <p className="footnote">
              {shown.some((product) => product.id === "workbuddy") ? "“用过”来自 WorkBuddy 本地会话记录。" : ""}专家的启用和对话在各自的产品里完成，这里只读。
            </p>
          </>
        )}
      </div>
    </section>
  );
}

function WorkBuddyGroups({ items, catalogCount }: { items: Capability[]; catalogCount: number }) {
  const mine = items.filter((item) => item.origin === "mine");
  const market = items.filter((item) => item.origin !== "mine");
  return (
    <>
      <Group title="我做的专家" note={`${mine.length} 个 · 来自 WorkBuddy 的“我的专家”`} items={mine} mine agentId="workbuddy" />
      <Group
        title="从专家市场添加"
        note={`${market.length} 个已下载到本机${catalogCount ? ` · 专家中心共 ${catalogCount} 个` : ""}`}
        items={market}
        agentId="workbuddy"
      />
    </>
  );
}
