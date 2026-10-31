"use client";

import { joinNames } from "../../../lib/format";
import type { SyncAction } from "../../../lib/types";

const ACTION_LABELS: Record<SyncAction["action"], string> = {
  create: "新建",
  replace: "替换（先备份旧版本）",
  noop: "不需要改动",
};

/** One Agent's copy in a per-Agent install plan: what happens where, backups, who else sees it. */
export function ActionDetail({ action, agentName }: { action: SyncAction; agentName: (id: string) => string }) {
  const others = (action.alsoVisibleTo || []).filter((id) => id !== action.agentId);
  return (
    <div className="plan-action">
      <div className="plan-line">
        <span className={`tag ${action.action === "noop" ? "mute" : action.action === "replace" ? "warn" : ""}`}>{ACTION_LABELS[action.action]}</span>
        <code title={action.destination}>{action.destination}</code>
      </div>
      {action.realDestination && action.realDestination !== action.destination ? (
        <p>
          这是一个软链接，实际写入 <code>{action.realDestination}</code>，链接本身保持不变。
        </p>
      ) : null}
      {action.reason === "same-directory" ? <p>目标和来源是同一个文件夹，已经是这一份了。</p> : null}
      {action.reason === "shared-with-target" ? <p>和 {agentName(action.sharedWithAgentId || "")} 共用同一个文件夹，只写一次。</p> : null}
      {action.action === "noop" && !action.reason && action.identical ? <p>{agentName(action.agentId)} 里已经有内容相同的一份。</p> : null}
      {others.length ? (
        <p className="plan-shared">
          写入后 <b>{joinNames(others.map(agentName))}</b> 也会看到这次改动——它们读的是同一个文件夹。
        </p>
      ) : null}
      {action.backup ? (
        <p>
          旧版本备份到 <code>{action.backup}</code>
        </p>
      ) : null}
      {action.skippedLinks?.length ? <p>有 {action.skippedLinks.length} 个指向技能外部的链接不会被复制。</p> : null}
    </div>
  );
}
