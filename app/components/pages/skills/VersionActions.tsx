"use client";

import { useEffect, useEffectEvent, useState } from "react";
import { refreshAfterWrite } from "../../../hooks/refresh";
import { useMarkBusy } from "../../../hooks/useBusy";
import { useResource } from "../../../hooks/useResource";
import { useUndoToast } from "../../../hooks/useUndoToast";
import { api, errorMessage } from "../../../lib/api";
import { formatMonthDay, joinNames } from "../../../lib/format";
import { applyFailureMessage, classifyApplyError } from "../../../lib/plan-flow";
import { CHANGE_LABELS, orderChanges, versionGap, type DiffLine, type VersionGap } from "../../../lib/skill-diff";
import type { SkillView } from "../../../lib/skill-model";
import type { SkillInstance, SyncPlan } from "../../../lib/types";
import { useData } from "../../providers/DataProvider";
import { useToast } from "../../providers/ToastProvider";
import { Modal } from "../../ui/Modal";
import { RunningProgress } from "../../ui/RunningProgress";
import { ActionDetail } from "./ActionDetail";

const copyLabel = (instance: SkillInstance, name: (id: string) => string) =>
  `${name(instance.agentId)}${instance.modifiedAt ? `（${formatMonthDay(instance.modifiedAt)}）` : ""}`;

/** 用较新的一份更新: the newest copy over the older ones, each backed up first. */
function UpdateOlderDialog({ view, gap, onClose }: { view: SkillView; gap: VersionGap; onClose: () => void }) {
  const { agentName } = useData();
  const toast = useToast();
  const undoToast = useUndoToast();
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  useMarkBusy(running);
  const input = { sourceInstanceId: gap.newest.id, targetAgentIds: [...new Set(gap.older.map((item) => item.agentId))], mode: "copy" as const };
  const makePlan = useEffectEvent(() => api.planSync(input));
  useEffect(() => {
    let cancelled = false;
    makePlan().then(
      (next) => !cancelled && setPlan(next),
      (planError: unknown) => !cancelled && setError(errorMessage(planError, "无法生成更新计划。")),
    );
    return () => {
      cancelled = true;
    };
  }, []);
  const writes = plan ? plan.actions.filter((action) => action.action !== "noop").length : 0;
  const names = joinNames(input.targetAgentIds.map(agentName));

  const run = async () => {
    setRunning(true);
    try {
      const result = await api.executeSync(input);
      undoToast(`已用 ${agentName(gap.newest.agentId)} 的版本更新 ${names} 里的 ${view.title}`, result);
      onClose();
    } catch (runError) {
      const message = applyFailureMessage(classifyApplyError(runError), runError, "更新失败，没有改动任何文件。");
      setError(message);
      toast.show(message, { tone: "error" });
    } finally {
      setRunning(false);
    }
    refreshAfterWrite();
  };

  return (
    <Modal
      wide
      title={`用较新的一份更新「${view.title}」`}
      onClose={onClose}
      busy={running}
      footer={
        <>
          {running ? (
            <div className="foot-progress">
              <RunningProgress label="正在更新…" expectedMs={4_000} detail="替换前先备份；完成前不能关闭。" />
            </div>
          ) : null}
          <small>替换前先备份，之后可以在提示里或历史里撤销</small>
          <span className="acts-right">
            <button type="button" className="btn ghost" onClick={onClose} disabled={running}>
              取消
            </button>
            <button type="button" className="btn primary" disabled={!plan || !writes || running} onClick={() => void run()}>
              {running ? "正在更新…" : plan && !writes ? "没有需要改动的" : "确认更新"}
            </button>
          </span>
        </>
      }
    >
      <div className="install-scope">
        <p>
          用 <b>{copyLabel(gap.newest, agentName)}</b> 的版本，更新 {joinNames(gap.older.map((item) => copyLabel(item, agentName)))} 里较旧的副本。
        </p>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : !plan ? (
          <p className="muted small">正在生成更新计划…</p>
        ) : (
          <div className="plan-list">
            {plan.actions.map((action) => (
              <div key={`${action.agentId}-${action.destination}`} className="plan-agent">
                <b>{agentName(action.agentId)}</b>
                <ActionDetail action={action} agentName={agentName} />
              </div>
            ))}
            {(plan.warnings || []).map((warning) => (
              <p key={warning} className="plan-warning">
                {warning}
              </p>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

function DiffLines({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="code wrap diff skill-diff-lines" aria-label="逐行差异">
      <code>
        {orderChanges(lines).map((line, index) => (
          <span key={index} className={`ln ${line.kind === "added" ? "add" : line.kind === "removed" ? "del" : line.kind === "skip" ? "skip" : ""}`}>
            {line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : line.kind === "skip" ? "⋯ " : "  "}
            {line.text}
            {"\n"}
          </span>
        ))}
      </code>
    </pre>
  );
}

/** 查看差异: which files differ, then line by line (older → newest). */
function DiffDialog({ view, gap, onClose }: { view: SkillView; gap: VersionGap; onClose: () => void }) {
  const { agentName } = useData();
  const [olderId, setOlderId] = useState(gap.older[0].id);
  const older = gap.older.find((item) => item.id === olderId) || gap.older[0];
  const diff = useResource(`skill-diff:${gap.newest.id}:${older.id}`, () => api.skillDiff(gap.newest.id, older.id));
  const entries = diff.data?.entries || [];
  const [picked, setPicked] = useState<string | null>(null);
  const path = picked && entries.some((entry) => entry.path === picked) ? picked : entries[0]?.path || null;
  const file = useResource(path ? `skill-diff-file:${gap.newest.id}:${older.id}:${path}` : null, () => api.skillDiffFile(gap.newest.id, older.id, path || ""));
  const summary = diff.data?.summary;

  return (
    <Modal wide title={`「${view.title}」两份的差异`} onClose={onClose}>
      <div className="skill-diff">
        <div className="skill-diff-head">
          {gap.older.length > 1 ? (
            <label className="field inline">
              <span>和哪一份比</span>
              <select value={older.id} onChange={(event) => setOlderId(event.target.value)}>
                {gap.older.map((item) => (
                  <option key={item.id} value={item.id}>
                    {copyLabel(item, agentName)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <p className="muted small">
            较旧：{copyLabel(older, agentName)} → 较新：{copyLabel(gap.newest, agentName)}。“+”是较新的一份多出来的行，“-”是较旧的一份里有、较新的一份里没有的行。
          </p>
        </div>
        {diff.status === "error" && !diff.data ? (
          <p className="form-error" role="alert">
            {errorMessage(diff.error, "比较失败。")}
          </p>
        ) : !diff.data ? (
          <p className="muted small">正在比较…</p>
        ) : !entries.length ? (
          <p className="muted small">文件内容相同。</p>
        ) : (
          <div className="skill-diff-body">
            <div className="skill-diff-files" role="listbox" aria-label="不同的文件">
              {summary ? (
                <p className="muted small">
                  {entries.length} 个文件不同{diff.data.truncated ? "（文件太多，只列出一部分）" : ""}
                </p>
              ) : null}
              {entries.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  role="option"
                  aria-selected={entry.path === path}
                  className={`skill-diff-file ${entry.path === path ? "on" : ""}`}
                  onClick={() => setPicked(entry.path)}
                >
                  <code>{entry.path}</code>
                  <small>{CHANGE_LABELS[entry.change]}</small>
                </button>
              ))}
            </div>
            <div className="skill-diff-view">
              {!path ? null : file.status === "error" && !file.data ? (
                <p className="form-error">{errorMessage(file.error, "读取差异失败。")}</p>
              ) : !file.data ? (
                <p className="muted small">正在读取…</p>
              ) : file.data.previewKind !== "text" ? (
                <p className="muted small">{file.data.reason || "这个文件不能逐行比较。"}</p>
              ) : (
                <>
                  <DiffLines lines={file.data.lines} />
                  {file.data.truncated ? <p className="muted small">文件很长，只比较了前 2000 行。</p> : null}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Under "最新的一份在 …": 用较新的一份更新 and 查看差异. */
export function VersionActions({ view }: { view: SkillView }) {
  const { agentName } = useData();
  const [open, setOpen] = useState<"update" | "diff" | null>(null);
  const gap = versionGap(view);
  if (!gap) return null;
  const targets = joinNames([...new Set(gap.older.map((item) => item.agentId))].map(agentName));
  return (
    <div className="version-acts">
      <button type="button" className="btn sm" onClick={() => setOpen("update")}>
        用 {agentName(gap.newest.agentId)} 的版本更新 {targets}
      </button>
      <button type="button" className="btn sm ghost" onClick={() => setOpen("diff")}>
        查看差异
      </button>
      {open === "update" ? <UpdateOlderDialog view={view} gap={gap} onClose={() => setOpen(null)} /> : null}
      {open === "diff" ? <DiffDialog view={view} gap={gap} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
