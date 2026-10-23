"use client";

import { useState, type ReactNode } from "react";
import { isUnsupported, useResource } from "../../hooks/useResource";
import { api, ApiError, errorMessage } from "../../lib/api";
import { COPY_FAILED, copyText } from "../../lib/clipboard";
import { CopiesIcon } from "../icons";
import { useToast } from "../providers/ToastProvider";
import { CodeView, languageLabel, MaskNote } from "../ui/CodeView";
import { EmptyState, KvTable, Loading } from "../ui/basics";

export { copyText };

export function CopyPathButton({ path, label = "复制路径", compact }: { path: string; label?: string; compact?: boolean }) {
  const toast = useToast();
  return (
    <button
      type="button"
      className={`btn sm ${compact ? "icon-only" : ""}`}
      title={compact ? `${label}：${path}` : undefined}
      aria-label={compact ? label : undefined}
      onClick={async () => {
        const copied = await copyText(path);
        toast.show(copied ? `已${label}` : COPY_FAILED, copied ? {} : { tone: "error" });
      }}
    >
      <CopiesIcon />
      {compact ? null : label}
    </button>
  );
}

/** Masked, read-only configuration from /api/config-detail. */
export function ConfigDetailView({
  kind,
  id,
  instance,
  rowsTitle = "主要设置",
  filesTitle = "原始配置",
  note,
  actions,
  emptyText,
}: {
  kind: string;
  id: string;
  instance?: string;
  rowsTitle?: string;
  filesTitle?: string;
  note?: ReactNode;
  actions?: ReactNode;
  emptyText?: string;
}) {
  const detail = useResource(`detail:${kind}:${id}:${instance || ""}`, () => api.configDetail(kind, id, instance));
  const [fileIndex, setFileIndex] = useState(0);

  if (detail.status === "error") {
    const missing = detail.error instanceof ApiError && detail.error.status === 404;
    return (
      <EmptyState tone={missing || isUnsupported(detail.error) ? "plain" : "error"} title={missing ? emptyText || "没有可读取的配置" : "读取配置失败"}>
        {errorMessage(detail.error)}
      </EmptyState>
    );
  }
  if (!detail.data) return <Loading label="正在读取配置…" rows={5} />;

  const { rows, files, location } = detail.data;
  const file = files[Math.min(fileIndex, Math.max(0, files.length - 1))];
  return (
    <div className="config-detail">
      <section>
        {rowsTitle ? <h3>{rowsTitle}</h3> : null}
        <KvTable rows={rows.map((row) => ({ label: row.label, value: row.value }))} label={rowsTitle} />
      </section>
      {file ? (
        <section>
          <h3>{filesTitle}</h3>
          {files.length > 1 ? (
            <div className="filetabs" role="tablist" aria-label="配置文件">
              {files.map((item, index) => (
                <button
                  key={`${item.path}-${index}`}
                  type="button"
                  role="tab"
                  aria-selected={item === file}
                  className={item === file ? "on" : ""}
                  onClick={() => setFileIndex(index)}
                >
                  {item.label || item.path}
                </button>
              ))}
            </div>
          ) : null}
          <div className="code-meta">
            <code>{file.path}</code>
            <span>{languageLabel(file.language, file.path)} · 只读</span>
          </div>
          <CodeView text={file.text} language={file.language} path={file.path} truncated={file.truncated} />
          <MaskNote text={file.text} />
        </section>
      ) : null}
      {note ? <p className="footnote">{note}</p> : null}
      {location || actions ? (
        <div className="insp-acts">
          {actions}
          {location ? <CopyPathButton path={location} /> : null}
        </div>
      ) : null}
    </div>
  );
}
