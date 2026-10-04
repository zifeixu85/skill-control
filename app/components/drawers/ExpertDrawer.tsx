"use client";

import { useMemo, useState } from "react";
import { useNow } from "../../hooks/useNow";
import { api, assetUrl } from "../../lib/api";
import { formatMonthDay, joinNames } from "../../lib/format";
import type { Capability } from "../../lib/types";
import { FileBrowser, type FileSource } from "../files/FileBrowser";
import { ConfigDetailView } from "../files/ConfigDetailView";
import { useData } from "../providers/DataProvider";
import { useNav } from "../providers/NavProvider";
import { ExpertAvatar } from "../ui/Avatar";
import { KvTable, Tabs } from "../ui/basics";
import { Drawer } from "./Drawer";

type Tab = "overview" | "files" | "config";

export function capabilityKindLabel(capability: Capability): string {
  if (capability.kind === "expert-team") return `专家团 · ${capability.memberCount} 位成员`;
  return capability.kindLabel || "专家";
}

function SkillLinks({ names }: { names: string[] }) {
  const { views } = useData();
  const { go } = useNav();
  const byName = new Map(views.map((view) => [view.techName.toLowerCase(), view]));
  return (
    <div className="list-names">
      {names.map((name) => {
        const view = byName.get(name.toLowerCase());
        return view ? (
          <button key={name} type="button" onClick={() => go("skills", { skillId: view.id })} title="在技能页查看">
            {name}
          </button>
        ) : (
          <span key={name}>{name}</span>
        );
      })}
    </div>
  );
}

function Overview({ capability }: { capability: Capability }) {
  const now = useNow();
  const members = capability.members.length > 1 ? capability.members : [];
  return (
    <>
      <p className="desc">{capability.description || "没有介绍"}</p>
      {capability.defaultPrompt ? (
        <section>
          <h3>开场提示</h3>
          <p className="quote">{capability.defaultPrompt}</p>
        </section>
      ) : null}
      {(capability.quickPrompts || []).length > 1 ? (
        <section>
          <h3>快捷提示</h3>
          <ul className="plain-list">
            {(capability.quickPrompts || []).map((prompt) => (
              <li key={prompt}>{prompt}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {members.length ? (
        <section>
          <h3>{members.length} 位成员</h3>
          <div className="members">
            {members.map((member) => (
              <div className="member" key={member.id}>
                <span className="plogo round sm letter-mute" aria-hidden="true">
                  <span className="av-letter">{(member.displayName || member.name || "?")[0]}</span>
                </span>
                <div>
                  <b>{member.displayName || member.name}</b>
                  <span title={member.description}>{member.profession || member.description}</span>
                </div>
                <em>{member.maxTurns ? `最多 ${member.maxTurns} 轮` : ""}</em>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {(capability.skills || []).length ? (
        <section>
          <h3>自带 {(capability.skills || []).length} 个技能</h3>
          <SkillLinks names={capability.skills || []} />
        </section>
      ) : null}
      {capability.tags.length ? (
        <section>
          <h3>标签</h3>
          <div className="inside">
            {capability.tags.map((tag) => (
              <span key={tag} className="tag mute">
                {tag}
              </span>
            ))}
          </div>
        </section>
      ) : null}
      <section>
        <h3>详情</h3>
        <KvTable
          rows={[
            { label: "模型", value: capability.model },
            { label: "最大轮次", value: capability.maxTurns ? String(capability.maxTurns) : "" },
            { label: "技能数", value: capability.skillCount ? `${capability.skillCount} 个` : "" },
            { label: "定时任务", value: capability.cronJobs ? `${capability.cronJobs} 个` : "" },
            { label: "插件", value: joinNames(capability.plugins || []) },
            { label: "工作区", value: capability.workspacePath || "" },
            { label: "由谁写入", value: joinNames(capability.managedBy || []) },
            {
              label: "使用情况",
              value: capability.used
                ? `用过 ${capability.used.count} 次，最近一次 ${formatMonthDay(capability.used.lastUsedAt, now || undefined)}`
                : capability.productId === "workbuddy"
                  ? "本机会话记录里还没有用过"
                  : "",
            },
            { label: "位置", value: capability.sourcePath },
          ]}
        />
      </section>
      {capability.origin === "mine" ? (
        <div className="confirm quiet">
          <b>这是你做的专家</b>
          <p>{capability.packaged ? "已经打包成 zip，可以发给别人导入。" : "还没打包。"}专家的启用和对话在 WorkBuddy 里完成，这里只读。</p>
        </div>
      ) : null}
    </>
  );
}

export function ExpertDrawer({ capabilityId, onClose }: { capabilityId: string; onClose: () => void }) {
  const { capabilities } = useData();
  const [tab, setTab] = useState<Tab>("overview");
  const capability = capabilities.data?.products.flatMap((product) => product.items).find((item) => item.id === capabilityId);
  const source = useMemo<FileSource>(
    () => ({
      key: `capability:${capabilityId}`,
      list: () => api.capabilityFiles(capabilityId),
      read: (path) => api.capabilityFile(capabilityId, path),
      asset: (path) => assetUrl.capability(capabilityId, path),
      preferred: capability?.primaryFilePath || null,
    }),
    [capabilityId, capability?.primaryFilePath],
  );
  if (!capability) return null;
  return (
    <Drawer
      label={`${capability.displayName} 详情`}
      icon={<ExpertAvatar capability={capability} size="lg" />}
      title={capability.displayName || capability.name}
      subtitle={capability.profession || `${capability.productName} · ${capabilityKindLabel(capability)}`}
      onClose={onClose}
      wide={tab !== "overview"}
      tabs={
        <Tabs
          tabs={[
            { id: "overview", label: "概览" },
            { id: "files", label: "文件" },
            { id: "config", label: "配置详情" },
          ]}
          value={tab}
          onChange={setTab}
          label="专家详情"
        />
      }
    >
      <div role="tabpanel" className="insp-body">
        {tab === "overview" ? <Overview capability={capability} /> : null}
        {tab === "files" ? <FileBrowser source={source} /> : null}
        {tab === "config" ? (
          <ConfigDetailView
            kind="expert"
            id={capability.id}
            filesTitle="角色与清单文件"
            note={capability.kind === "expert-team" ? "专家团的每位成员各有一份角色文件，可在上方切换查看。" : undefined}
          />
        ) : null}
      </div>
    </Drawer>
  );
}
