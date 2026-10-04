"use client";

import { useMemo, useState } from "react";
import { api, assetUrl } from "../../../lib/api";
import { formatMonthDay } from "../../../lib/format";
import { groupCopies, type SkillView } from "../../../lib/skill-model";
import { FileBrowser, type FileSource } from "../../files/FileBrowser";
import { ConfigDetailView } from "../../files/ConfigDetailView";
import { CloseIcon, FinderIcon } from "../../icons";
import { useData } from "../../providers/DataProvider";
import { Tabs } from "../../ui/basics";
import { primaryInstance, useReveal } from "./SkillActions";
import { SkillOverview } from "./SkillOverview";

export type InspectorTab = "overview" | "files" | "config";

const TABS: { id: InspectorTab; label: string }[] = [
  { id: "overview", label: "概览" },
  { id: "files", label: "文件" },
  { id: "config", label: "配置详情" },
];

/** Which physical copy the 文件 / 配置详情 tabs show; one option per real directory. */
function CopyPicker({ view, value, onChange }: { view: SkillView; value: string; onChange: (id: string) => void }) {
  const { agents, agentName } = useData();
  const groups = groupCopies(view, agents.map((agent) => agent.id));
  if (groups.length < 2) return null;
  // Several instances can share a directory; select the option of the group holding `value`.
  const current = groups.find((group) => group.instances.some((instance) => instance.id === value)) || groups[0];
  return (
    <label className="field inline">
      <span>查看哪一份</span>
      <select value={current.instances[0].id} onChange={(event) => onChange(event.target.value)}>
        {groups.map((group) => (
          <option key={group.key} value={group.instances[0].id}>
            {group.agentIds.map(agentName).join("、")} · {group.path}
            {group.modifiedAt ? ` · ${formatMonthDay(group.modifiedAt)}` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SkillInspector({
  view,
  tab,
  onTab,
  pendingAgent,
  onPending,
  onClose,
  onMessage,
}: {
  view: SkillView;
  tab: InspectorTab;
  onTab: (tab: InspectorTab) => void;
  pendingAgent: string | null;
  onPending: (agentId: string | null) => void;
  onClose: () => void;
  onMessage: (message: string) => void;
}) {
  const { primary } = useData();
  const reveal = useReveal();
  const fallback = primaryInstance(view, primary);
  const [chosen, setChosen] = useState<string | null>(null);
  const instanceId =
    chosen && view.skill.instances.some((instance) => instance.id === chosen) ? chosen : fallback?.id || "";

  const source = useMemo<FileSource>(
    () => ({
      key: `skill:${instanceId}`,
      list: () => api.skillFiles(instanceId),
      read: (path) => api.skillFile(instanceId, path),
      asset: (path) => assetUrl.skill(instanceId, path),
      preferred: "SKILL.md",
    }),
    [instanceId],
  );

  return (
    <div className="insp">
      <div className="insp-head">
        <div className="insp-title">
          <h2 id="inspector-title">{view.title}</h2>
          {view.showTech ? <div className="tech">{view.techName}</div> : null}
        </div>
        <button type="button" className="btn ghost sm x" onClick={onClose} aria-label="关闭详情">
          <CloseIcon />
        </button>
      </div>
      <Tabs tabs={TABS} value={tab} onChange={onTab} label="技能详情" idBase={`skill-${view.id}`} />
      <div role="tabpanel" aria-labelledby={`skill-${view.id}-tab-${tab}`} className="insp-body">
        {tab === "overview" ? (
          <SkillOverview
            view={view}
            pendingAgent={pendingAgent}
            onPending={onPending}
            onMessage={onMessage}
            onShowFiles={() => onTab("files")}
          />
        ) : null}
        {tab === "files" && instanceId ? (
          <>
            <CopyPicker view={view} value={instanceId} onChange={setChosen} />
            <FileBrowser key={instanceId} source={source} />
          </>
        ) : null}
        {tab === "config" && instanceId ? (
          <>
            <CopyPicker view={view} value={instanceId} onChange={setChosen} />
            <ConfigDetailView
              key={instanceId}
              kind="skill"
              id={view.id}
              instance={instanceId}
              rowsTitle="基本信息"
              filesTitle="SKILL.md（敏感内容已隐藏）"
              actions={
                <button type="button" className="btn sm" onClick={() => reveal(instanceId)}>
                  <FinderIcon />
                  在访达中显示
                </button>
              }
            />
          </>
        ) : null}
      </div>
    </div>
  );
}
