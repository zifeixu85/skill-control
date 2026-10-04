"use client";

import type { KeyboardEvent } from "react";
import { useNow } from "../../../hooks/useNow";
import { formatRelative } from "../../../lib/format";
import { shortRevision, STATUS_LABELS, STATUS_TONES, type UpdateUnit } from "../../../lib/updates";
import { useData } from "../../providers/DataProvider";
import { useNav } from "../../providers/NavProvider";
import { AgentAvatar } from "../../ui/Avatar";

export function StatusTag({ unit }: { unit: UpdateUnit }) {
  const tone = STATUS_TONES[unit.status];
  return <span className={`tag ${tone === "ok" ? "" : tone}`}>{STATUS_LABELS[unit.status]}</span>;
}

export function VersionLine({ unit }: { unit: UpdateUnit }) {
  const current = shortRevision(unit.current);
  const latest = shortRevision(unit.latest);
  if (!current && !latest) return null;
  return (
    <span className="versions">
      <code>{current || "未知"}</code>
      {latest && latest !== current ? (
        <>
          {" → "}
          <code className="latest">{latest}</code>
        </>
      ) : null}
    </span>
  );
}

/** One update unit (a source shared by one or more installed copies). */
export function UnitRow({ unit }: { unit: UpdateUnit }) {
  const { agentName } = useData();
  const { openDrawer } = useNav();
  const now = useNow();
  const open = () => openDrawer({ kind: "update", id: unit.unitKey });
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      open();
    }
  };
  const agents = [...new Set(unit.instances.map((instance) => instance.agentId))];
  return (
    <div className="urow" role="button" tabIndex={0} onClick={open} onKeyDown={onKeyDown} aria-label={`${unit.title}，${STATUS_LABELS[unit.status]}`}>
      <div className="urow-main">
        <div className="urow-title">
          <b>{unit.title}</b>
          <StatusTag unit={unit} />
          {unit.lockDrift ? <span className="tag mute">锁记录落后</span> : null}
          {unit.stale ? <span className="tag mute">结果可能过期</span> : null}
        </div>
        <div className="urow-meta">
          <span>{unit.sourceLabel || unit.sourceType}</span>
          <VersionLine unit={unit} />
          {unit.error ? <span className="danger-text">{unit.error.message}</span> : null}
          {!unit.error && unit.reason ? <span>{unit.reason}</span> : null}
        </div>
      </div>
      <div className="urow-agents" title={unit.instances.map((instance) => `${agentName(instance.agentId)}：${instance.path}`).join("\n")}>
        {agents.slice(0, 4).map((agentId) => (
          <AgentAvatar key={agentId} id={agentId} size="sm" />
        ))}
        <span className="muted small">{unit.instances.length} 处</span>
      </div>
      <div className="urow-side">
        {unit.checkedAt && now ? <span className="muted small">{formatRelative(unit.checkedAt, now)}检查</span> : null}
        {unit.action.kind !== "none" && (unit.status === "update-available" || unit.status === "conflict" || unit.action.kind === "guide") ? (
          <span className="btn sm">{unit.action.label || "查看"}</span>
        ) : null}
      </div>
    </div>
  );
}
