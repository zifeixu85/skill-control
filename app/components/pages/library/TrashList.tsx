"use client";

import { useState } from "react";
import { refreshAfterWrite } from "../../../hooks/refresh";
import { useNow } from "../../../hooks/useNow";
import { isUnsupported, useResource } from "../../../hooks/useResource";
import { api, errorMessage } from "../../../lib/api";
import { formatRelative } from "../../../lib/format";
import { TRASH_SOURCE_LABELS, type TrashEntry } from "../../../lib/history";
import { applyFailureMessage, classifyApplyError } from "../../../lib/plan-flow";
import { useData } from "../../providers/DataProvider";
import { useToast } from "../../providers/ToastProvider";

/** One row: its own confirm step, busy state and error, so rows never block each other. */
function TrashRow({ item, now }: { item: TrashEntry; now: number }) {
  const { agentName } = useData();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const restore = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api.restoreTrash(item.trashId);
      toast.show(`已把 ${item.name} 放回原位`);
      setConfirming(false);
    } catch (restoreError) {
      const message = applyFailureMessage(classifyApplyError(restoreError), restoreError, "恢复失败，没有改动任何文件。");
      setError(message);
      toast.show(message, { tone: "error" });
    } finally {
      setBusy(false);
    }
    refreshAfterWrite();
  };

  return (
    <div aria-busy={busy}>
      <span className="trash-main">
        <b>{item.name}</b>
        <code title={item.originalPath}>{item.originalPath}</code>
        {error ? (
          <span className="form-error small" role="alert">
            {error}
          </span>
        ) : null}
      </span>
      <em>
        {TRASH_SOURCE_LABELS[item.source] || item.source}
        {item.agentId ? ` · ${agentName(item.agentId)}` : ""}
        {item.kind === "link" ? " · 链接" : ""}
        {item.links.length ? ` · 连同 ${item.links.length} 个链接` : ""}
      </em>
      <em>{item.removedAt && now ? formatRelative(item.removedAt, now) : ""}</em>
      {confirming ? (
        <span className="inline-confirm">
          <button type="button" className="btn sm primary" disabled={busy} onClick={() => void restore()}>
            {busy ? "正在恢复…" : "确认放回"}
          </button>
          <button type="button" className="btn sm ghost" disabled={busy} onClick={() => setConfirming(false)}>
            取消
          </button>
        </span>
      ) : (
        <button type="button" className="btn sm" onClick={() => setConfirming(true)} title={`放回 ${item.originalPath}`}>
          恢复
        </button>
      )}
    </div>
  );
}

/** One trash for everything: library removals, per-Agent uninstalls and undo leftovers. */
export function TrashList() {
  const trash = useResource("trash", () => api.trash());
  const now = useNow();
  if (isUnsupported(trash.error)) return <p className="muted small">本地服务还没有提供回收站。</p>;
  if (trash.status === "error" && !trash.data) {
    return (
      <p className="form-error" role="alert">
        {errorMessage(trash.error, "读取回收站失败。")}
      </p>
    );
  }
  if (!trash.data) return <p className="muted small">正在读取回收站…</p>;
  if (!trash.data.length) return <p className="muted small">回收站是空的。</p>;
  return (
    <div className="copies trash">
      {trash.data.map((item) => (
        <TrashRow key={item.trashId} item={item} now={now} />
      ))}
    </div>
  );
}
