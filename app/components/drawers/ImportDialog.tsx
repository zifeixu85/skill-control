"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { api, assetUrl, errorMessage } from "../../lib/api";
import { filesFromDrop, filesFromInput, planFolder, zipFolder, type FolderFile } from "../../lib/folder-zip";
import { desktopFolderPicker, importErrorMessage, skillChoicesOf, type SkillChoice } from "../../lib/import-errors";
import { formatBytes } from "../../lib/format";
import type { ImportedSkill } from "../../lib/types";
import { FileBrowser, type FileSource } from "../files/FileBrowser";
import { useNav } from "../providers/NavProvider";
import { Modal } from "../ui/Modal";
import { InstallScopeBody, InstallScopeFooter, useInstallScope } from "./InstallScope";

const PACKAGE = /\.(skill|zip)$/i;

/** Import a .skill / .zip package or a folder: read it → look inside → choose the scope → review → confirm. */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const { go } = useNav();
  const folderInput = useRef<HTMLInputElement>(null);
  // React has no prop for it: let this input pick a directory.
  useEffect(() => {
    folderInput.current?.setAttribute("webkitdirectory", "");
  }, []);
  const [skill, setSkill] = useState<ImportedSkill | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [choices, setChoices] = useState<{ skills: SkillChoice[]; pick: (root: string) => void } | null>(null);
  const folderPicker = desktopFolderPicker();
  const [dragging, setDragging] = useState(false);
  const ctrl = useInstallScope(skill ? { kind: "import", skill } : null, null, onClose);
  const busy = reading || ctrl.flow.applying;
  const source = useMemo<FileSource | null>(
    () =>
      skill
        ? {
            key: `import:${skill.importId}`,
            list: async () => ({ entries: skill.entries, fileCount: skill.fileCount, directoryCount: skill.directoryCount, truncated: false }),
            read: (path) => api.importFile(skill.importId, path),
            asset: (path) => assetUrl.importAsset(skill.importId, path),
            preferred: "SKILL.md",
          }
        : null,
    [skill],
  );

  /** One way in for every source; a package with several skills asks which one, then tries again. */
  const stage = async (attempt: (root: string | null) => Promise<ImportedSkill>, root: string | null, fallback: string) => {
    setError("");
    setChoices(null);
    setReading(true);
    try {
      setSkill(await attempt(root));
    } catch (importError) {
      const skills = skillChoicesOf(importError);
      if (skills) setChoices({ skills, pick: (picked) => void stage(attempt, picked, fallback) });
      else setError(importErrorMessage(importError, fallback));
    } finally {
      setReading(false);
    }
  };

  const readFile = async (file: File | undefined) => {
    if (!file || busy) return;
    if (!PACKAGE.test(file.name)) {
      setError("只支持 .skill 或 .zip 技能包，或者一个技能文件夹。");
      return;
    }
    await stage((root) => api.importSkill(file, root), null, "无法读取这个技能包。");
  };

  /** A folder from the page (no path): zipped here and imported like a .zip. */
  const readFolder = async (files: FolderFile[]) => {
    if (busy) return;
    const plan = planFolder(files);
    if (plan.error) {
      setError(plan.error);
      return;
    }
    let zipped: File;
    try {
      zipped = await zipFolder(plan);
    } catch (zipError) {
      setError(errorMessage(zipError, "无法打包这个文件夹。"));
      return;
    }
    await stage((root) => api.importSkill(zipped, root), null, "无法读取这个文件夹。");
  };

  /** Desktop: the system folder dialog gives a full path; the service reads it (no links, no .git). */
  const pickFolder = async () => {
    if (!folderPicker || busy) return;
    const path = await folderPicker().catch(() => null);
    if (path) await stage((root) => api.importFolder(path, root), null, "无法读取这个文件夹。");
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    const item = event.dataTransfer.items?.[0];
    const file = [...event.dataTransfer.files][0];
    void filesFromDrop(item).then(
      (files) => (files ? readFolder(files) : readFile(file)),
      () => setError("读不了这个文件夹，试试“选择文件夹”。"),
    );
  };

  return (
    <Modal
      wide={Boolean(skill)}
      title="导入技能"
      onClose={onClose}
      busy={busy}
      footer={
        skill ? (
          <InstallScopeFooter ctrl={ctrl} onCancel={onClose} />
        ) : (
          <>
            <small>确认前不会写入任何文件</small>
            <span className="acts-right">
              <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
                取消
              </button>
            </span>
          </>
        )
      }
    >
      {!skill ? (
        <div className="import-pick">
          <p>选择一个 .skill / .zip 技能包，或一个技能文件夹（里面有 SKILL.md）。先看里面的内容，再决定装到哪里。</p>
          <label
            className={`dropzone ${dragging ? "on" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <input type="file" accept=".skill,.zip" onChange={(event) => void readFile(event.target.files?.[0])} />
            <b>{reading ? "正在读取…" : "把 .skill、.zip 或技能文件夹拖到这里"}</b>
            <span>或者点这里选择文件</span>
          </label>
          {choices ? (
            <div className="import-choices" role="group" aria-label="选一个技能导入">
              <p>这里面有 {choices.skills.length} 个技能，一次导入一个，选一个：</p>
              <div className="import-choice-list">
                {choices.skills.map((choice) => (
                  <button key={choice.root} type="button" className="import-choice" disabled={busy} onClick={() => choices.pick(choice.root)}>
                    <b>{choice.name}</b>
                    <code>{choice.root}</code>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <div className="import-alt">
            {folderPicker ? (
              <button type="button" className="btn sm" disabled={busy} onClick={() => void pickFolder()}>
                选择文件夹
              </button>
            ) : (
              <label className="btn sm">
                <input
                  ref={folderInput}
                  type="file"
                  className="sr-only"
                  multiple
                  disabled={busy}
                  onChange={(event) => {
                    const files = filesFromInput(event.target.files);
                    event.target.value = "";
                    void readFolder(files);
                  }}
                />
                选择文件夹
              </label>
            )}
            <span className="muted small">.git、node_modules 不会导入</span>
          </div>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <p className="import-hint">
            想从 GitHub 安装？在 Agent 里说“从 GitHub 装这个技能”，装了 skill-control 技能的 Agent 会下载、检查后放进技能库。
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                onClose();
                go("settings", { section: "integration" });
              }}
            >
              设置 → Agent 集成
            </button>
          </p>
        </div>
      ) : (
        <div className="import-body">
          <div className="import-head">
            <div className="import-title">
              <b>{skill.displayName || skill.name}</b>
              {skill.displayName && skill.displayName !== skill.name ? <span className="tech">{skill.name}</span> : null}
            </div>
            <p>{skill.description || "没有介绍"}</p>
            <small>
              {skill.fileCount} 个文件 · {formatBytes(skill.byteCount)} · 指纹 {skill.shortHash}
            </small>
            {skill.ignoredCount ? (
              <small>
                只导入了技能文件夹{skill.root ? ` ${skill.root}` : ""}，旁边的 {skill.ignoredCount} 个文件（比如仓库的 README）没有导入。
              </small>
            ) : null}
            {skill.skippedLinks?.length ? <small>有 {skill.skippedLinks.length} 个链接没有跟随。</small> : null}
          </div>
          {source ? (
            <details className="import-files">
              <summary>查看技能内容（{skill.fileCount} 个文件）</summary>
              <FileBrowser source={source} />
            </details>
          ) : null}
          <InstallScopeBody ctrl={ctrl} />
        </div>
      )}
    </Modal>
  );
}
