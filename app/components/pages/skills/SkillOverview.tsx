"use client";

import { useState } from "react";
import { useNow } from "../../../hooks/useNow";
import { formatMonthDay, joinNames } from "../../../lib/format";
import { groupCopies, type SkillView, type SlotState } from "../../../lib/skill-model";
import { FinderIcon, LockIcon } from "../../icons";
import { useData } from "../../providers/DataProvider";
import { useNav } from "../../providers/NavProvider";
import { AgentAvatar } from "../../ui/Avatar";
import { Switch } from "../../ui/basics";
import { UninstallDialog } from "../../drawers/UninstallDialog";
import { InstallPlan } from "./InstallPlan";
import { LibraryActions } from "./LibraryActions";
import { SkillActions, useReveal } from "./SkillActions";
import { SkillSource } from "./SkillSource";
import { SkillUsage } from "./SkillUsage";

function whereText(view: SkillView, slot: SlotState, now: number): string {
  if (slot.kind !== "installed") return slot.reason || "没有安装";
  if (slot.copies > 1) return `存了 ${slot.copies} 份，见下方`;
  const instance = view.writable[slot.agentId]?.[0];
  if (!instance) return "已安装";
  const date = formatMonthDay(instance.modifiedAt, now || undefined);
  return `${instance.root}${date ? ` · ${date}更新` : ""}`;
}

function WhereRow({
  view,
  slot,
  onInstall,
  onUninstall,
}: {
  view: SkillView;
  slot: SlotState;
  onInstall: () => void;
  onUninstall: () => void;
}) {
  const { agentName } = useData();
  const now = useNow();
  const name = agentName(slot.agentId);
  const off = slot.kind === "missing" || slot.kind === "refused";
  return (
    <div className={`where-row ${off ? "off" : ""}`}>
      <AgentAvatar id={slot.agentId} size="md" />
      <div>
        <b>{name}</b>
        <span title={whereText(view, slot, now)}>{whereText(view, slot, now)}</span>
      </div>
      {slot.kind === "readonly" || slot.kind === "plugin" ? (
        <span className="tag info" title={slot.reason || undefined}>
          <LockIcon className="tag-icon" />
          只读
        </span>
      ) : slot.kind === "refused" ? (
        <span className="tag mute" title={slot.reason || undefined}>
          不能安装
        </span>
      ) : (
        <Switch
          checked={slot.kind === "installed"}
          label={`在 ${name} 中启用`}
          onChange={() => (slot.kind === "installed" ? onUninstall() : onInstall())}
        />
      )}
    </div>
  );
}

export function SkillOverview({
  view,
  pendingAgent,
  onPending,
  onShowFiles,
}: {
  view: SkillView;
  pendingAgent: string | null;
  onPending: (agentId: string | null) => void;
  onShowFiles: () => void;
}) {
  const { primary, agentName } = useData();
  const { go } = useNav();
  const now = useNow();
  const reveal = useReveal();
  const [removing, setRemoving] = useState<string | null>(null);
  const copies = groupCopies(view, primary);

  return (
    <>
      <p className="desc">{view.summary || "没有介绍"}</p>
      <section>
        <h3>装在哪里</h3>
        <div className="where">
          {primary.map((agentId) => (
            <WhereRow
              key={agentId}
              view={view}
              slot={view.slots[agentId]}
              onInstall={() => onPending(agentId)}
              onUninstall={() => setRemoving(agentId)}
            />
          ))}
        </div>
        {pendingAgent ? (
          <InstallPlan key={pendingAgent} view={view} agentId={pendingAgent} onDone={() => onPending(null)} />
        ) : null}
      </section>
      {copies.length ? (
        <section>
          <h3>本机上的副本</h3>
          <div className="copies">
            {copies.map((group) => (
              <div key={group.key}>
                <code title={group.path}>{group.path}</code>
                <em>
                  {joinNames(group.agentIds.map(agentName))}
                  {group.agentIds.length > 1 ? " 共用" : ""}
                  {group.readOnly ? " · 只读" : group.label ? ` · ${group.label}` : ""}
                </em>
                <em>{formatMonthDay(group.modifiedAt, now || undefined)}</em>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`在访达中显示 ${group.path}`}
                  title="在访达中显示"
                  onClick={() => reveal(group.instances[0].id)}
                >
                  <FinderIcon />
                </button>
              </div>
            ))}
          </div>
          {view.multi ? <p className="footnote">同一个 Agent 里有多份时，建议保留最新的一份，其余移到备份。</p> : null}
          {view.differs && view.skill.newest ? (
            <p className="footnote">
              最新的一份在 {agentName(view.skill.newest.agentId)}
              {view.skill.newest.version ? `（v${view.skill.newest.version}）` : ""}
              {view.skill.behind?.length ? `，${joinNames(view.skill.behind.map(agentName))} 里有旧一些的副本` : ""}。
            </p>
          ) : null}
        </section>
      ) : null}
      <SkillSource view={view} />
      <LibraryActions view={view} />
      <section>
        <h3>使用情况</h3>
        <SkillUsage view={view} />
      </section>
      {view.otherAgents.length ? (
        <section>
          <h3>其他 Agent 里也有</h3>
          <div className="others">
            {view.otherAgents.map((agentId) => (
              <button key={agentId} type="button" className="chip-agent" onClick={() => go("agent", { agentId })}>
                <AgentAvatar id={agentId} />
                {agentName(agentId)}
              </button>
            ))}
          </div>
        </section>
      ) : null}
      <section>
        <h3>内容</h3>
        <button type="button" className="doc" onClick={onShowFiles}>
          <b>{view.title}</b>
          <span>{view.skill.fileCount} 个文件 · 查看 SKILL.md 和全部文件</span>
        </button>
      </section>
      <SkillActions view={view} />
      {removing ? (
        <UninstallDialog skillId={view.id} skillTitle={view.title} agentId={removing} onClose={() => setRemoving(null)} />
      ) : null}
    </>
  );
}
