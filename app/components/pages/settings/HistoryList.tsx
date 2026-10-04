"use client";

import { isUnsupported, useResource } from "../../../hooks/useResource";
import { api, errorMessage } from "../../../lib/api";
import { formatDateTime, joinNames } from "../../../lib/format";
import { HISTORY_ACTION_LABELS } from "../../../lib/history";
import { useData } from "../../providers/DataProvider";
import { useNav } from "../../providers/NavProvider";

/** Every recorded write, newest first, with 撤销 where the service can put things back. */
export function HistoryList() {
  const history = useResource("history", () => api.history(100));
  const { scan, agentName } = useData();
  const { setRestoreHistoryId } = useNav();

  if (isUnsupported(history.error)) {
    // Older service: show the plain install log from the scan.
    const legacy = scan.data?.history || [];
    if (!legacy.length) return <p className="muted small">还没有安装记录。</p>;
    return (
      <div className="copies">
        {legacy.slice(0, 20).map((entry) => (
          <div key={entry.id}>
            <code>{entry.skillName}</code>
            <em>装到 {joinNames(entry.targets)}</em>
            <em>{formatDateTime(entry.createdAt)}</em>
          </div>
        ))}
      </div>
    );
  }
  if (history.status === "error" && !history.data) return <p className="form-error">{errorMessage(history.error, "读取历史失败。")}</p>;
  if (!history.data) return <p className="muted small">正在读取历史…</p>;
  if (!history.data.length) return <p className="muted small">还没有任何改动记录。</p>;

  return (
    <div className="copies history">
      {history.data.map((entry) => (
        <div key={entry.id}>
          <span className="trash-main">
            <b>
              {HISTORY_ACTION_LABELS[entry.action] || entry.action}
              {entry.skill ? ` · ${entry.skill}` : ""}
            </b>
            <span className="muted small">
              {entry.agents.length ? joinNames(entry.agents.map(agentName)) : ""}
              {entry.mode ? ` · ${entry.mode === "symlink" ? "软链接" : "复制"}` : ""}
              {entry.backups.length ? ` · 备份 ${entry.backups.length} 份` : ""}
            </span>
          </span>
          <em>{formatDateTime(entry.at)}</em>
          <em />
          {entry.restorable ? (
            <button type="button" className="btn sm" onClick={() => setRestoreHistoryId(entry.id)}>
              撤销
            </button>
          ) : (
            <span className="muted small" title={entry.reason || undefined}>
              {entry.reason || "不能撤销"}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
