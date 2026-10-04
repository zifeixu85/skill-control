"use client";

import { indexProgress, isIndexing, type UsageIndex, type UsageStatus } from "../../../lib/usage";

/** "正在首次统计…" while the usage index is still being built in the background. */
export function IndexProgress({ status, index }: { status: UsageStatus | null; index: UsageIndex | null }) {
  if (status?.state === "error") {
    return (
      <p className="index-note error" role="alert">
        统计中断：{status.error || "读取会话记录时出错"}。已统计的部分仍然可以查看。
      </p>
    );
  }
  if (!isIndexing(status, index)) return null;
  const { indexed, total, ratio } = indexProgress(status, index);
  return (
    <div className="index-progress" role="status" aria-live="polite">
      <div>
        <b>{index?.updatedAt ? "正在更新统计…" : "正在首次统计（约 40 秒）…"}</b>
        <span>
          {total ? `${indexed.toLocaleString("zh-CN")} / ${total.toLocaleString("zh-CN")} 个文件` : "正在列出会话文件"}
          ，数字会随统计增加
        </span>
      </div>
      <span
        className="progress"
        role="progressbar"
        aria-label="统计进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
      >
        <i style={{ transform: `scaleX(${ratio})` }} />
      </span>
    </div>
  );
}
