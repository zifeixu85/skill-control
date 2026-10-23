"use client";

import { usePersistent } from "../../hooks/usePersistent";
import { COPIED_FOR_AI, COPY_FAILED, copyText } from "../../lib/clipboard";
import { remedyModes, remedyModeStore, REMEDY_MODE_LABELS, remedyText, resolveMode, type Remedy, type RemedyMode } from "../../lib/remedy";
import { ChevronIcon, CopiesIcon, SparkIcon } from "../icons";
import { useToast } from "../providers/ToastProvider";
import { Segmented } from "./basics";
import { CodeView } from "./CodeView";

export function useCopyRemedy() {
  const toast = useToast();
  return async (text: string, mode: RemedyMode) => {
    const copied = await copyText(text);
    toast.show(copied ? (mode === "ai" ? COPIED_FOR_AI : "已复制，粘贴到终端运行") : COPY_FAILED, copied ? {} : { tone: "error" });
  };
}

/** 修复方式: a 「AI 指令 | 终端指令」 toggle (terminal only when there are commands) and one-click copy. */
export function RemedyPanel({ remedy, label, id }: { remedy: Remedy; label: string; id?: string }) {
  const [preferred, setPreferred] = usePersistent(remedyModeStore);
  const mode = resolveMode(preferred, remedy);
  const modes = remedyModes(remedy);
  const text = remedyText(remedy, mode);
  const copy = useCopyRemedy();
  return (
    <div className="remedy" id={id} role="group" aria-label={`${label} 的修复方式`}>
      <div className="remedy-head">
        <span>修复方式</span>
        {modes.length > 1 ? (
          <Segmented label="修复方式" value={mode} onChange={setPreferred} items={modes.map((id) => ({ id, label: REMEDY_MODE_LABELS[id] }))} />
        ) : (
          <span className="muted small">{REMEDY_MODE_LABELS[mode]}</span>
        )}
        <button type="button" className="btn sm primary" onClick={() => void copy(text, mode)}>
          <CopiesIcon />
          {mode === "ai" ? "复制 AI 指令" : "复制命令"}
        </button>
      </div>
      <p className="muted small">
        {mode === "ai" ? "只复制，不改任何东西：粘贴给你常用的 AI（如 Codex、Claude Code），它会按说明检查并修好。" : "只复制，不会替你运行：在终端里运行下面的命令。"}
      </p>
      <CodeView text={text} language="text" wrap label={mode === "ai" ? "AI 指令" : "终端命令"} />
    </div>
  );
}

/** Shown next to fix buttons so nobody has to guess what a click does. */
export const ACTION_NOTES = {
  copy: "只复制给 AI，不改任何东西",
  preview: "先列出要改的文件和内容，确认后才执行，可以从历史撤销",
} as const;

/**
 * Row-level fix entries: "复制 AI 指令" copies at once (nothing changes); "查看指令" opens the
 * 修复方式 panel below the row (AI / terminal tabs). One caption says what the copy does.
 */
export function RemedyActions({ remedy, open, onToggle, controls }: { remedy: Remedy; open: boolean; onToggle: () => void; controls: string }) {
  const copy = useCopyRemedy();
  return (
    <>
      {remedy.prompt ? (
        <button type="button" className="btn sm" title={ACTION_NOTES.copy} onClick={() => void copy(remedy.prompt, "ai")}>
          <SparkIcon />
          复制 AI 指令
        </button>
      ) : null}
      <button
        type="button"
        className={`btn sm ghost ${open ? "on" : ""}`}
        aria-expanded={open}
        aria-controls={controls}
        title={remedy.commands.length ? "查看 AI 指令和终端命令" : "查看 AI 指令"}
        onClick={onToggle}
      >
        {open ? "收起" : "查看"}
        <ChevronIcon className={`chev ${open ? "open" : ""}`} aria-hidden="true" />
      </button>
    </>
  );
}

/** Kept for rows that only toggle the panel. */
export function RemedyButton({ open, onToggle, controls }: { open: boolean; onToggle: () => void; controls: string }) {
  return (
    <button type="button" className={`btn sm ${open ? "on" : ""}`} aria-expanded={open} aria-controls={controls} onClick={onToggle}>
      <SparkIcon />
      {open ? "收起指令" : "查看 AI 指令"}
    </button>
  );
}

/** Top of 体检 / 更新: one instruction that covers everything listed. */
export function RemedyAllBar({ remedy, what }: { remedy: Remedy | null; what: string }) {
  const copy = useCopyRemedy();
  if (!remedy?.prompt) return null;
  return (
    <div className="remedy-all">
      <div>
        <b>复制给 AI，一次处理全部</b>
        <span>把{what}整理成一段说明，粘贴给你常用的 AI（如 Codex、Claude Code），它会逐项检查并处理；改动前会先告诉你。</span>
      </div>
      <button type="button" className="btn primary" onClick={() => void copy(remedy.prompt, "ai")}>
        <CopiesIcon />
        复制给 AI
      </button>
    </div>
  );
}
