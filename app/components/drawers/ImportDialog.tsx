"use client";

import { useMemo, useState, type DragEvent } from "react";
import { refreshAfterWrite } from "../../hooks/refresh";
import { noop, useEscape } from "../../hooks/useEscape";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { Scrim } from "../ui/Scrim";
import { api, assetUrl, errorMessage } from "../../lib/api";
import { applyFailureMessage, classifyApplyError } from "../../lib/plan-flow";
import { formatBytes } from "../../lib/format";
import type { ImportedSkill, SyncPlan } from "../../lib/types";
import { FileBrowser, type FileSource } from "../files/FileBrowser";
import { ActionDetail } from "../pages/skills/InstallPlan";
import { useData } from "../providers/DataProvider";
import { useUndoToast } from "../../hooks/useUndoToast";
import { useToast } from "../providers/ToastProvider";
import { AgentAvatar } from "../ui/Avatar";

type Step =
  | { name: "pick"; busy: boolean }
  | { name: "preview"; skill: ImportedSkill }
  | { name: "plan"; skill: ImportedSkill; plan: SyncPlan };

/** .skill import: read the package → choose Agents → review the plan → confirm. */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const { agents, primary, agentName } = useData();
  const undoToast = useUndoToast();
  const toast = useToast();
  const ref = useFocusTrap<HTMLDivElement>();
  const [step, setStep] = useState<Step>({ name: "pick", busy: false });
  const installable = agents.filter((agent) => agent.available && !agent.refuseInstall);
  const [targets, setTargets] = useState<string[]>(() =>
    primary.filter((id) => installable.some((agent) => agent.id === id)),
  );
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [dragging, setDragging] = useState(false);
  const reading = step.name === "pick" && step.busy;
  const busy = working || reading;
  // While something is being read or written, Esc and 取消 do nothing (Esc stays caught here).
  useEscape(true, busy ? noop : onClose);
  const imported = step.name === "pick" ? null : step.skill;
  const source = useMemo<FileSource | null>(
    () =>
      imported
        ? {
            key: `import:${imported.importId}`,
            list: async () => ({
              entries: imported.entries,
              fileCount: imported.fileCount,
              directoryCount: imported.directoryCount,
              truncated: false,
            }),
            read: (path) => api.importFile(imported.importId, path),
            asset: (path) => assetUrl.importAsset(imported.importId, path),
            preferred: "SKILL.md",
          }
        : null,
    [imported],
  );

  const readFile = async (file: File | undefined) => {
    if (!file || busy) return;
    if (!/\.skill$/i.test(file.name)) {
      setError("只支持 .skill 技能包。");
      return;
    }
    setError("");
    setStep({ name: "pick", busy: true });
    try {
      setStep({ name: "preview", skill: await api.importSkill(file) });
    } catch (importError) {
      setError(errorMessage(importError, "无法读取这个技能包。"));
      setStep({ name: "pick", busy: false });
    }
  };

  const plan = async (skill: ImportedSkill) => {
    setWorking(true);
    setError("");
    try {
      setStep({ name: "plan", skill, plan: await api.planImport(skill.importId, targets) });
    } catch (planError) {
      setError(errorMessage(planError, "无法生成安装计划。"));
    } finally {
      setWorking(false);
    }
  };

  const install = async (skill: ImportedSkill) => {
    setWorking(true);
    setError("");
    try {
      const result = await api.executeImport(skill.importId, targets);
      undoToast(`已安装 ${skill.displayName || skill.name}`, result);
      onClose();
    } catch (installError) {
      const message = applyFailureMessage(classifyApplyError(installError), installError, "安装失败，没有写入任何文件。");
      setError(message);
      toast.show(message, { tone: "error" });
    } finally {
      setWorking(false);
    }
    refreshAfterWrite();
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    void readFile([...event.dataTransfer.files][0]);
  };

  return (
    <Scrim onDismiss={onClose} busy={busy}>
      <div className={`sheet ${imported ? "wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby="import-title" ref={ref} tabIndex={-1}>
        <h2 id="import-title">导入技能</h2>
        {step.name === "pick" ? (
          <>
            <p>选择一个 .skill 技能包。先预览内容，再决定装到哪些 Agent，确认前不会写入任何文件。</p>
            <label
              className={`dropzone ${dragging ? "on" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <input type="file" accept=".skill" onChange={(event) => void readFile(event.target.files?.[0])} />
              <b>{step.busy ? "正在读取…" : "把 .skill 文件拖到这里"}</b>
              <span>或者点这里选择文件</span>
            </label>
          </>
        ) : (
          <>
            <div className="import-head">
              <b>{step.skill.displayName || step.skill.name}</b>
              <span className="tech">{step.skill.name}</span>
              <p>{step.skill.description || "没有介绍"}</p>
              <small>
                {step.skill.fileCount} 个文件 · {formatBytes(step.skill.byteCount)} · 指纹 {step.skill.shortHash}
              </small>
            </div>
            {source ? (
              <details className="import-files" open={step.name === "preview"}>
                <summary>查看技能内容</summary>
                <FileBrowser source={source} />
              </details>
            ) : null}
            {step.name === "preview" ? (
              <fieldset className="targets">
                <legend>装到哪些 Agent</legend>
                {agents.filter((agent) => agent.available).map((agent) => (
                  <label key={agent.id} className={agent.refuseInstall ? "disabled" : ""} title={agent.refuseInstall || undefined}>
                    <input
                      type="checkbox"
                      disabled={Boolean(agent.refuseInstall)}
                      checked={targets.includes(agent.id)}
                      onChange={(event) =>
                        setTargets((current) =>
                          event.target.checked ? [...current, agent.id] : current.filter((id) => id !== agent.id),
                        )
                      }
                    />
                    <AgentAvatar id={agent.id} size="sm" />
                    <span>{agent.name}</span>
                    {agent.refuseInstall ? <small>{agent.refuseInstall}</small> : agent.copyOnly ? <small>只支持复制</small> : null}
                  </label>
                ))}
              </fieldset>
            ) : (
              <div className="plan-list">
                {step.plan.actions.map((action) => (
                  <div key={action.agentId} className="plan-agent">
                    <b>
                      <AgentAvatar id={action.agentId} size="sm" /> {agentName(action.agentId)}
                    </b>
                    <ActionDetail action={action} agentName={agentName} />
                  </div>
                ))}
                {(step.plan.warnings || []).map((warning) => (
                  <p key={warning} className="plan-warning">
                    {warning}
                  </p>
                ))}
              </div>
            )}
          </>
        )}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="acts">
          <small>替换已有技能前会自动备份</small>
          <span className="acts-right">
            <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
              取消
            </button>
            {step.name === "preview" ? (
              <button type="button" className="btn primary" disabled={!targets.length || working} onClick={() => plan(step.skill)}>
                {working ? "正在生成…" : "查看安装计划"}
              </button>
            ) : null}
            {step.name === "plan" ? (
              <button
                type="button"
                className="btn primary"
                disabled={working || !step.plan.actions.some((action) => action.action !== "noop")}
                onClick={() => install(step.skill)}
              >
                {working ? "正在安装…" : "确认安装"}
              </button>
            ) : null}
          </span>
        </div>
      </div>
    </Scrim>
  );
}
