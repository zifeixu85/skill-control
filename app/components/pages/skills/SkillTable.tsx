"use client";

import type { CSSProperties, KeyboardEvent } from "react";
import type { ChipSpec } from "../../../lib/chips";
import type { SkillView } from "../../../lib/skill-model";
import { useData } from "../../providers/DataProvider";
import { AgentAvatar } from "../../ui/Avatar";
import { ItemText, TagStack } from "../../ui/Item";
import { Slot } from "./Slot";

/** The 标记 column: copies, differing versions, and how the primary Agents get it. */
function skillChips(view: SkillView, primary: string[]): ChipSpec[] {
  const chips: ChipSpec[] = [];
  if (view.multi) chips.push({ id: "multi", kind: "status", tone: "warn", text: "多份" });
  if (view.differs && !view.multi) chips.push({ id: "differs", kind: "status", tone: "warn", text: "版本不同" });
  const via = primary.map((agentId) => view.slots[agentId]).find((slot) => slot && (slot.kind === "plugin" || slot.kind === "readonly"));
  if (via) chips.push({ id: "via", kind: "kind", tone: "info", text: via.kind === "plugin" ? "插件自带" : "只读", title: via.label });
  return chips;
}

function SkillRow({
  view,
  primary,
  selected,
  onOpen,
  onSlot,
}: {
  view: SkillView;
  primary: string[];
  selected: boolean;
  onOpen: (id: string) => void;
  onSlot: (view: SkillView, agentId: string) => void;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(view.id);
    }
  };
  return (
    <div
      className={`row ${selected ? "sel" : ""}`}
      role="row"
      tabIndex={0}
      aria-current={selected ? "true" : undefined}
      aria-label={`${view.title}，按回车查看详情`}
      data-skill={view.id}
      data-detail-trigger=""
      onClick={() => onOpen(view.id)}
      onKeyDown={onKeyDown}
    >
      <div role="cell" className="cell-main">
        <ItemText title={view.title} meta={view.showTech ? view.techName : null} mono desc={view.summary || null} />
      </div>
      <div role="cell" className="cell-tags">
        <TagStack chips={skillChips(view, primary)} />
      </div>
      {primary.map((agentId) => (
        <div role="cell" className="slotcell" key={agentId}>
          {view.slots[agentId] ? <Slot slot={view.slots[agentId]} onClick={() => onSlot(view, agentId)} /> : null}
        </div>
      ))}
      <div role="cell" className="usage metric">
        {view.usageTotal ? `${view.usageTotal} 次` : <span className="none">—</span>}
      </div>
    </div>
  );
}

export function SkillTable({
  views,
  total,
  selectedId,
  onOpen,
  onSlot,
  onMore,
}: {
  views: SkillView[];
  total: number;
  selectedId: string | null;
  onOpen: (id: string) => void;
  onSlot: (view: SkillView, agentId: string) => void;
  onMore: () => void;
}) {
  const { primary, agentName } = useData();
  const style = {
    "--cols": primary.map(() => "var(--slot-w)").join(" ") || "0px",
    "--n": primary.length,
  } as CSSProperties;
  return (
    <>
      <div className="table" role="table" aria-label="技能列表" aria-rowcount={total} style={style}>
        <div className="thead" role="row">
          <div role="columnheader">技能</div>
          <div role="columnheader" className="th-tags">标记</div>
          {primary.map((agentId) => (
            <div role="columnheader" key={agentId} title={agentName(agentId)}>
              <AgentAvatar id={agentId} size="sm" />
              <span className="agname">{agentName(agentId)}</span>
            </div>
          ))}
          <div role="columnheader">近 30 天</div>
        </div>
        {views.length ? (
          views.map((view) => (
            <SkillRow
              key={view.id}
              view={view}
              primary={primary}
              selected={view.id === selectedId}
              onOpen={onOpen}
              onSlot={onSlot}
            />
          ))
        ) : (
          <div className="table-empty" role="row">
            <div role="cell">没有符合条件的技能</div>
          </div>
        )}
      </div>
      {total > views.length ? (
        <div className="more">
          <button type="button" className="btn" onClick={onMore}>
            再显示 {Math.min(80, total - views.length)} 个（共 {total}）
          </button>
        </div>
      ) : null}
      <div className="legend" aria-label="图例">
        <span>
          <i className="mini on" />
          已安装
        </span>
        <span>
          <i className="mini" />
          没装，点一下安装
        </span>
        <span>
          <i className="mini via" />
          只读或插件自带
        </span>
        <span>
          <i className="mini on b" />
          同一个 Agent 里存了多份
        </span>
        <span>“近 30 天”= 会话里实际调用或读取的次数</span>
      </div>
    </>
  );
}
