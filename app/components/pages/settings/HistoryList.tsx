"use client";

import { isUnsupported, useResource } from "../../../hooks/useResource";
import { api, errorMessage } from "../../../lib/api";
import { formatDateTime, joinNames } from "../../../lib/format";
import { HISTORY_ACTION_LABELS } from "../../../lib/history";
import { useData } from "../../providers/DataProvider";
import { useNav } from "../../providers/NavProvider";
import { ItemText } from "../../ui/Item";

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
      <div className="lrows">
        {legacy.slice(0, 20).map((entry) => (
          <div key={entry.id} className="lrow">
            <ItemText title={entry.skillName} meta={`装到 ${joinNames(entry.targets)}`} />
            <div className="metric">{formatDateTime(entry.createdAt)}</div>
            <span />
          </div>
        ))}
      </div>
    );
  }
  if (history.status === "error" && !history.data) {
    return (
      <p className="form-error" role="alert">
        {errorMessage(history.error, "读取历史失败。")}
      </p>
    );
  }
  if (!history.data) return <p className="muted small">正在读取历史…</p>;
  if (!history.data.length) return <p className="muted small">还没有任何改动记录。</p>;

  return (
    <div className="lrows">
      {history.data.map((entry) => (
        <div key={entry.id} className="lrow">
          <div className="it-main">
            <div className="it-title">
              {HISTORY_ACTION_LABELS[entry.action] || entry.action}
              {entry.skill ? ` · ${entry.skill}` : ""}
            </div>
            {entry.agents.length || entry.mode || entry.backups.length ? (
              <div className="it-meta">
                {entry.agents.length ? joinNames(entry.agents.map(agentName)) : ""}
                {entry.mode ? ` · ${entry.mode === "symlink" ? "软链接" : "复制"}` : ""}
                {entry.backups.length ? ` · 备份 ${entry.backups.length} 份` : ""}
              </div>
            ) : null}
            {entry.units.length ? (
              <div className="it-desc" title={entry.units.map((unit) => unit.title).join("\n")}>
                {entry.units.slice(0, 3).map((unit) => unit.title).join("；")}
                {entry.units.length > 3 ? ` 等 ${entry.units.length} 项` : ""}
              </div>
            ) : null}
            {!entry.restorable && entry.reason ? <div className="it-desc">{entry.reason}</div> : null}
          </div>
          <div className="metric">{formatDateTime(entry.at)}</div>
          <div className="it-acts">
            {entry.restorable ? (
              <button type="button" className="btn sm" onClick={() => setRestoreHistoryId(entry.id)}>
                撤销
              </button>
            ) : (
              <span className="muted small">不能撤销</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
