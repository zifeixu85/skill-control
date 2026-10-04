"use client";

import { useMemo, useState } from "react";
import { useEscape } from "../../../hooks/useEscape";
import { useScrollMemory } from "../../../hooks/useScrollMemory";
import {
  filterChips,
  matchesFilter,
  matchesQuery,
  sortViews,
  type FilterChip,
  type SkillView,
} from "../../../lib/skill-model";
import { PlusIcon, SearchIcon } from "../../icons";
import { useData } from "../../providers/DataProvider";
import { useNav } from "../../providers/NavProvider";
import { useToast } from "../../providers/ToastProvider";
import { AgentAvatar } from "../../ui/Avatar";
import { Loading, TopBar } from "../../ui/basics";
import { SkillInspector, type InspectorTab } from "./SkillInspector";
import { SkillTable } from "./SkillTable";

const PAGE_SIZE = 80;

function Filters({ chips, value, onChange }: { chips: FilterChip[]; value: string; onChange: (id: string) => void }) {
  return (
    <div className="filters" role="radiogroup" aria-label="筛选技能">
      {chips.map((chip) => (
        <button
          key={chip.id}
          type="button"
          role="radio"
          aria-checked={value === chip.id}
          className={`fchip ${value === chip.id ? "on" : ""} ${chip.count === 0 ? "zero" : ""}`}
          onClick={() => onChange(chip.id)}
        >
          {chip.agentId ? <AgentAvatar id={chip.agentId} size="xs" /> : null}
          {chip.label}
          <em>{chip.count}</em>
        </button>
      ))}
    </div>
  );
}

export function SkillsPage() {
  const { views, primary, agentName, scan, viewsById } = useData();
  const nav = useNav();
  const toast = useToast();
  const scrollRef = useScrollMemory<HTMLDivElement>("skills");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [tab, setTab] = useState<InspectorTab>("overview");
  const [pending, setPending] = useState<{ skillId: string; agentId: string } | null>(null);

  const chips = useMemo(() => {
    const names = Object.fromEntries(primary.map((id) => [id, agentName(id)]));
    const list = filterChips(views, primary, names);
    if (nav.skillFilter.startsWith("agent:")) {
      const agentId = nav.skillFilter.slice(6);
      list.splice(1, 0, {
        id: nav.skillFilter,
        label: `装在 ${agentName(agentId)}`,
        count: views.filter((view) => matchesFilter(view, nav.skillFilter, primary)).length,
        agentId,
      });
    }
    return list;
  }, [views, primary, nav.skillFilter, agentName]);
  const filter = chips.some((chip) => chip.id === nav.skillFilter) ? nav.skillFilter : "all";
  const list = useMemo(
    () => sortViews(views.filter((view) => matchesFilter(view, filter, primary) && matchesQuery(view, nav.query))),
    [views, filter, primary, nav.query],
  );
  const shown = list.slice(0, limit);
  const selected = nav.selectedSkillId ? viewsById.get(nav.selectedSkillId) || null : null;
  const pendingAgent = pending && selected && pending.skillId === selected.id ? pending.agentId : null;

  useEscape(Boolean(selected), () => nav.selectSkill(null));
  useEscape(Boolean(pendingAgent), () => setPending(null));

  const open = (id: string) => {
    if (nav.selectedSkillId === id) {
      nav.selectSkill(null);
      return;
    }
    nav.selectSkill(id);
    setTab("overview");
    setPending(null);
  };
  const onSlot = (view: SkillView, agentId: string) => {
    const slot = view.slots[agentId];
    if (nav.selectedSkillId !== view.id) setTab("overview");
    nav.selectSkill(view.id);
    if (slot.kind === "missing") {
      setTab("overview");
      setPending({ skillId: view.id, agentId });
      return;
    }
    setPending(null);
    if (slot.kind === "installed") toast.show(`${agentName(agentId)} 里已经有这个技能了`);
    else toast.show(slot.reason || `${agentName(agentId)} 里的这个技能是只读的`);
  };
  const changeFilter = (id: string) => {
    nav.setSkillFilter(id);
    setLimit(PAGE_SIZE);
  };

  return (
    <section className="page" aria-labelledby="page-title">
      <TopBar
        title={<span id="page-title">技能</span>}
        sub={scan.data ? `${views.length} 个 · 装在哪里由你决定` : "正在读取…"}
      >
        <label className="search">
          <SearchIcon />
          <input
            id="skill-search"
            type="search"
            placeholder="搜索名称或介绍"
            aria-label="搜索技能"
            value={nav.query}
            onChange={(event) => {
              nav.setQuery(event.target.value);
              setLimit(PAGE_SIZE);
            }}
          />
          <kbd aria-hidden="true">⌘K</kbd>
        </label>
        <button type="button" className="btn" onClick={() => nav.setImportOpen(true)}>
          <PlusIcon />
          导入
        </button>
      </TopBar>
      <div className={`split ${selected ? "open" : ""} ${selected && tab !== "overview" ? "wide" : ""}`}>
        <div className="split-list">
          <Filters chips={chips} value={filter} onChange={changeFilter} />
          <div className="scroll" ref={scrollRef}>
            {scan.data ? (
              <SkillTable
                views={shown}
                total={list.length}
                selectedId={selected?.id || null}
                onOpen={open}
                onSlot={onSlot}
                onMore={() => setLimit((current) => current + PAGE_SIZE)}
              />
            ) : (
              <Loading label="正在读取技能…" rows={8} />
            )}
          </div>
        </div>
        <aside className="inspector" aria-labelledby={selected ? "inspector-title" : undefined} key={selected?.id || "none"}>
          {selected ? (
            <SkillInspector
              view={selected}
              tab={tab}
              onTab={setTab}
              pendingAgent={pendingAgent}
              onPending={(agentId) => setPending(agentId ? { skillId: selected.id, agentId } : null)}
              onClose={() => nav.selectSkill(null)}
              onMessage={(message) => toast.show(message)}
            />
          ) : null}
        </aside>
      </div>
    </section>
  );
}
