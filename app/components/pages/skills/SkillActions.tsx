"use client";

import { useCallback, useState } from "react";
import { api, errorMessage } from "../../../lib/api";
import type { SkillView } from "../../../lib/skill-model";
import type { SkillInstance } from "../../../lib/types";
import { ExportIcon, FinderIcon } from "../../icons";
import { useData } from "../../providers/DataProvider";
import { useToast } from "../../providers/ToastProvider";

export function useReveal() {
  const toast = useToast();
  return useCallback(
    async (instanceId: string) => {
      try {
        await api.reveal(instanceId);
      } catch (error) {
        toast.show(errorMessage(error, "无法打开这个文件夹。"), { tone: "error" });
      }
    },
    [toast],
  );
}

/** The copy that actions act on: the first primary Agent's writable copy, else any copy. */
export function primaryInstance(view: SkillView, primary: string[]): SkillInstance | null {
  for (const agentId of primary) {
    const own = view.writable[agentId]?.[0];
    if (own) return own;
  }
  return view.skill.instances[0] || null;
}

function download(blob: Blob, filename: string) {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

export function SkillActions({ view }: { view: SkillView }) {
  const { primary } = useData();
  const toast = useToast();
  const reveal = useReveal();
  const [busy, setBusy] = useState<"skill" | "zip" | null>(null);
  const instance = primaryInstance(view, primary);
  if (!instance) return null;

  const exportAs = async (format: "skill" | "zip") => {
    setBusy(format);
    try {
      download(await api.exportSkill(instance.id, format), `${instance.directoryName}.${format}`);
      toast.show(`已导出 ${view.title}（${format === "zip" ? "ZIP 压缩包" : ".skill 技能包"}）`);
    } catch (error) {
      toast.show(errorMessage(error, "导出失败。"), { tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="insp-acts">
      <button type="button" className="btn sm" onClick={() => reveal(instance.id)}>
        <FinderIcon />
        在访达中显示
      </button>
      <button type="button" className="btn sm" disabled={busy !== null} onClick={() => exportAs("skill")}>
        <ExportIcon />
        {busy === "skill" ? "正在打包…" : "导出 .skill"}
      </button>
      <button type="button" className="btn sm ghost" disabled={busy !== null} onClick={() => exportAs("zip")}>
        {busy === "zip" ? "正在打包…" : "导出 ZIP"}
      </button>
    </div>
  );
}
