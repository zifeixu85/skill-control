"use client";

import type { KeyboardEvent } from "react";
import { useNow } from "../../../hooks/useNow";
import { useResource } from "../../../hooks/useResource";
import { api } from "../../../lib/api";
import { isLibraryPath } from "../../../lib/library";
import { formatRelative } from "../../../lib/format";
import { shortRevision, STATUS_LABELS, STATUS_TONES, type UpdateUnit } from "../../../lib/updates";
import type { ChipSpec } from "../../../lib/chips";
import { useData } from "../../providers/DataProvider";
import { useNav } from "../../providers/NavProvider";
import { AgentAvatar } from "../../ui/Avatar";
import { ItemText, TagStack } from "../../ui/Item";

export function StatusTag({ unit }: { unit: UpdateUnit }) {
  const tone = STATUS_TONES[unit.status];
  return <span className={`tag ${tone === "ok" ? "" : tone}`}>{STATUS_LABELS[unit.status]}</span>;
}

/** Short text for the row button; long guidance stays in the drawer. */
export function actionButtonLabel(unit: UpdateUnit): string {
  if (unit.action.kind === "guide") return "查看步骤";
  return unit.action.label && unit.action.label.length <= 12 ? unit.action.label : "更新";
}

export function VersionLine({ unit }: { unit: UpdateUnit }) {
  const current = shortRevision(unit.current);
  const latest = shortRevision(unit.latest);
  if (!current && !latest) return null;
  return (
    <span className="versions">
      <code>{current || "未知"}</code>
      {latest && latest !== current && (unit.status === "update-available" || unit.status === "conflict") ? (
        <>
          {" → "}
          <code className="latest">{latest}</code>
        </>
      ) : null}
    </span>
  );
}

/** "库内一份，N 个 Agent 共用" when the unit's copy lives in ~/.agents/skills, else null. */
export function useLibraryShare(unit: UpdateUnit): string | null {
  const library = useResource("library", () => api.library());
  const root = library.data?.root || "~/.agents/skills";
  const inLibrary = unit.instances.find((instance) => isLibraryPath(instance.path, root));
  if (!inLibrary) return null;
  const name = inLibrary.path.slice(root.length + 1).split("/")[0];
  const entry = library.data?.entries.find((item) => item.name === name);
  const viewers = entry
    ? Object.values(entry.fanout).filter((fanout) => fanout.state === "visible").length
    : new Set(unit.instances.map((instance) => instance.agentId)).size;
  return `库内一份，${viewers} 个 Agent 共用`;
}

export function LibraryShare({ unit }: { unit: UpdateUnit }) {
  const text = useLibraryShare(unit);
  return text ? <span className="tag info">{text}</span> : null;
}

/** Status first, then how the copy is shared and anything stale about it. */
function unitChips(unit: UpdateUnit, share: string | null): ChipSpec[] {
  const tone = STATUS_TONES[unit.status];
  const chips: ChipSpec[] = [{ id: "status", kind: "status", text: STATUS_LABELS[unit.status], tone: tone === "ok" ? "ok" : (tone as ChipSpec["tone"]) }];
  if (share) chips.push({ id: "share", kind: "kind", tone: "info", text: share });
  if (unit.lockDrift) chips.push({ id: "lock", kind: "kind", text: "锁记录落后" });
  if (unit.stale) chips.push({ id: "stale", kind: "kind", text: "结果可能过期" });
  return chips;
}

/** One update unit: title / source · versions / explanation | tags | where + checked | action. */
export function UnitRow({ unit }: { unit: UpdateUnit }) {
  const { agentName } = useData();
  const { openDrawer } = useNav();
  const now = useNow();
  const share = useLibraryShare(unit);
  const open = () => openDrawer({ kind: "update", id: unit.unitKey });
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      open();
    }
  };
  const agents = [...new Set(unit.instances.map((instance) => instance.agentId))];
  const actionable = unit.action.kind !== "none" && (unit.status === "update-available" || unit.status === "conflict" || unit.action.kind === "guide");
  return (
    <div
      className="urow"
      role="button"
      tabIndex={0}
      data-detail-trigger=""
      onClick={open}
      onKeyDown={onKeyDown}
      aria-label={`${unit.title}，${STATUS_LABELS[unit.status]}`}
    >
      <ItemText
        title={unit.title}
        meta={
          <>
            {unit.sourceLabel || unit.sourceType}
            {unit.current || unit.latest ? <span className="sep">·</span> : null}
            <VersionLine unit={unit} />
          </>
        }
        desc={unit.error ? <span className="danger-text">{unit.error.message}</span> : unit.reason || null}
      />
      <div className="urow-tags">
        <TagStack chips={unitChips(unit, share)} />
      </div>
      <div className="urow-where metric" title={unit.instances.map((instance) => `${agentName(instance.agentId)}：${instance.path}`).join("\n")}>
        <span className="urow-agents">
          {agents.slice(0, 4).map((agentId) => (
            <AgentAvatar key={agentId} id={agentId} size="xs" />
          ))}
          {unit.instances.length ? <span>{unit.instances.length} 处</span> : null}
        </span>
        {unit.checkedAt && now ? <small>{formatRelative(unit.checkedAt, now)}检查</small> : null}
      </div>
      <div className="it-acts">{actionable ? <span className="btn sm">{actionButtonLabel(unit)}</span> : null}</div>
    </div>
  );
}
