"use client";

import { usePersistent } from "../../hooks/usePersistent";
import { COPIED_FOR_AI, COPY_FAILED, copyText } from "../../lib/clipboard";
import { remedyModes, remedyModeStore, REMEDY_MODE_LABELS, remedyText, resolveMode, type Remedy, type RemedyMode } from "../../lib/remedy";
import { CopiesIcon, SparkIcon } from "../icons";
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
          {mode === "ai" ? "复制给 AI" : "复制命令"}
        </button>
      </div>
      <p className="muted small">
        {mode === "ai" ? "复制后粘贴给你常用的 AI（如 Codex、Claude Code），它会按说明检查并修好。" : "在终端里运行下面的命令。"}
      </p>
      <CodeView text={text} language="text" wrap label={mode === "ai" ? "AI 指令" : "终端命令"} />
    </div>
  );
}

/** "让 AI 修复": opens the row's 修复方式 below it (the row keeps the open state). */
export function RemedyButton({ open, onToggle, controls }: { open: boolean; onToggle: () => void; controls: string }) {
  return (
    <button type="button" className={`btn sm ${open ? "on" : ""}`} aria-expanded={open} aria-controls={controls} onClick={onToggle}>
      <SparkIcon />
      {open ? "收起" : "让 AI 修复"}
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
