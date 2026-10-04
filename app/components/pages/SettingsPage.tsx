"use client";

import { usePersistent } from "../../hooks/usePersistent";
import { useScrollMemory } from "../../hooks/useScrollMemory";
import { errorMessage } from "../../lib/api";
import { formatDateTime, joinNames } from "../../lib/format";
import { persistentStore } from "../../lib/storage";
import type { ManagerConfig, SyncMode } from "../../lib/types";
import { useData } from "../providers/DataProvider";
import { useToast } from "../providers/ToastProvider";
import { AgentPicker } from "../shell/AgentPicker";
import { AgentAvatar } from "../ui/Avatar";
import { Loading, TopBar } from "../ui/basics";

export type ThemeChoice = "system" | "light" | "dark";
export const themeStore = persistentStore<ThemeChoice>("theme", "system", (value) =>
  ["system", "light", "dark"].includes(value),
);

function useConfigWriter() {
  const { updateConfig, savingConfig } = useData();
  const toast = useToast();
  const write = async (patch: Partial<ManagerConfig>, message: string, undoable = true) => {
    try {
      const { previous } = await updateConfig(patch);
      toast.show(message, {
        action: undoable
          ? {
              label: "撤销",
              run: async () => {
                await updateConfig(previous);
                toast.show("已撤销");
              },
            }
          : undefined,
      });
    } catch (error) {
      toast.show(errorMessage(error, "保存失败。"), { tone: "error" });
    }
  };
  return { write, saving: savingConfig };
}

function Choice<T extends string>({
  name,
  value,
  current,
  title,
  detail,
  onSelect,
  disabled,
}: {
  name: string;
  value: T;
  current: T;
  title: string;
  detail: string;
  onSelect: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <label className="opt card">
      <input type="radio" name={name} checked={current === value} disabled={disabled} onChange={() => onSelect(value)} />
      <span>
        {title}
        <small>{detail}</small>
      </span>
    </label>
  );
}

export function SettingsPage() {
  const { config, scan, agents, primary, agentName, integrations } = useData();
  const toast = useToast();
  const { write, saving } = useConfigWriter();
  const [theme, setTheme] = usePersistent(themeStore);
  const scrollRef = useScrollMemory<HTMLDivElement>("settings");
  const mode: SyncMode = config.data?.syncMode || "copy";
  const visible = config.data?.visibleAgentIds || [];

  return (
    <section className="page" aria-labelledby="page-title">
      <TopBar title={<span id="page-title">设置</span>} />
      <div className="scroll" ref={scrollRef}>
        {!config.data || !scan.data ? (
          <Loading rows={6} />
        ) : (
          <div className="set-grid">
            <section className="set-block" aria-labelledby="set-primary">
              <h2 id="set-primary">常用 Agent</h2>
              <p>Skill Control 只按这几个 Agent 检查差异和多份副本。其他 Agent 照常显示，但不会提醒你安装。</p>
              <AgentPicker
                name="primary-settings"
                selected={primary}
                onChange={(next) => void write({ primaryAgentIds: next }, `已设为常用：${joinNames(next.map(agentName))}`)}
                onLimit={(message) => toast.show(message)}
                disabled={saving}
              />
            </section>
            <section className="set-block" aria-labelledby="set-mode">
              <h2 id="set-mode">安装方式</h2>
              <p>把技能装到另一个 Agent 时默认怎么做。</p>
              <div className="radio-row">
                <Choice
                  name="sync-mode"
                  value="copy"
                  current={mode}
                  disabled={saving}
                  title="复制（推荐）"
                  detail="每个 Agent 一份独立副本；替换前自动备份"
                  onSelect={(value) => void write({ syncMode: value }, "安装方式改为复制")}
                />
                <Choice
                  name="sync-mode"
                  value="symlink"
                  current={mode}
                  disabled={saving}
                  title="软链接"
                  detail="所有 Agent 共用一份，改一处全部生效；只支持复制的 Agent 仍会复制"
                  onSelect={(value) => void write({ syncMode: value }, "安装方式改为软链接")}
                />
              </div>
            </section>
            <section className="set-block" aria-labelledby="set-theme">
              <h2 id="set-theme">外观</h2>
              <div className="radio-row three">
                <Choice name="theme" value="system" current={theme} title="跟随系统" detail="和 macOS 的外观一致" onSelect={setTheme} />
                <Choice name="theme" value="light" current={theme} title="浅色" detail="始终使用浅色" onSelect={setTheme} />
                <Choice name="theme" value="dark" current={theme} title="深色" detail="始终使用深色" onSelect={setTheme} />
              </div>
            </section>
            <section className="set-block" aria-labelledby="set-visible">
              <h2 id="set-visible">读取哪些 Agent 的技能</h2>
              <p>没勾选的 Agent 只统计数量，不读取技能内容，也不会出现在技能列表里。常用 Agent 总会读取。</p>
              <div className="check-grid">
                {agents
                  .filter((agent) => agent.available)
                  .map((agent) => {
                    const locked = primary.includes(agent.id);
                    const on = locked || visible.includes(agent.id);
                    return (
                      <label key={agent.id} className={locked ? "locked" : ""}>
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={locked || saving}
                          onChange={(event) => {
                            const next = event.target.checked
                              ? [...new Set([...visible, agent.id])]
                              : visible.filter((id) => id !== agent.id);
                            void write({ visibleAgentIds: next }, event.target.checked ? `开始读取 ${agent.name} 的技能` : `不再读取 ${agent.name} 的技能`);
                          }}
                        />
                        <AgentAvatar id={agent.id} size="sm" />
                        <span>{agent.name}</span>
                        <small>{agent.skillCount} 个</small>
                      </label>
                    );
                  })}
              </div>
            </section>
            <section className="set-block" aria-labelledby="set-roots">
              <h2 id="set-roots">技能文件夹</h2>
              <p>自动识别。软链接会显示它实际指向的位置。</p>
              <div className="copies">
                {agents
                  .filter((agent) => agent.available)
                  .flatMap((agent) =>
                    agent.roots.map((root) => (
                      <div key={`${agent.id}:${root.path}`}>
                        <code title={root.path}>
                          {root.path}
                          {root.realPath && root.realPath !== root.path ? ` → ${root.realPath}` : ""}
                        </code>
                        <em>{agent.name}</em>
                        <em>{root.available ? `${root.skillCount} 个` : "不存在"}</em>
                      </div>
                    )),
                  )}
              </div>
            </section>
            {integrations.data?.relatedProducts?.length ? (
              <section className="set-block" aria-labelledby="set-related">
                <h2 id="set-related">也检测到这些相关产品</h2>
                <p>它们不是 Agent 本身，Skill Control 只显示，不改动。</p>
                <div className="copies">
                  {integrations.data.relatedProducts.map((product) => (
                    <div key={product.id}>
                      <code>
                        {product.name}
                        {product.version ? ` ${product.version}` : ""}
                      </code>
                      <em>{product.notes}</em>
                      <em>{product.stateDir}</em>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
            <section className="set-block" aria-labelledby="set-history">
              <h2 id="set-history">备份与记录</h2>
              <p>
                每次替换前的旧版本都保存在 <code>~/.agent-skill-manager/backups</code>。
              </p>
              {scan.data.history.length ? (
                <div className="copies">
                  {scan.data.history.slice(0, 12).map((entry) => (
                    <div key={entry.id}>
                      <code>{entry.skillName}</code>
                      <em>
                        装到 {joinNames(entry.targets)} · {entry.mode === "symlink" ? "软链接" : "复制"}
                        {entry.backups ? ` · 备份 ${entry.backups} 份` : ""}
                      </em>
                      <em>{formatDateTime(entry.createdAt)}</em>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted small">还没有安装记录。</p>
              )}
            </section>
            <section className="set-block" aria-labelledby="set-privacy">
              <h2 id="set-privacy">数据与隐私</h2>
              <p>所有扫描都在本机完成。使用次数只统计会话记录里的调用，不读取对话内容，也不会上传。密钥和令牌在读取配置时就被隐藏。</p>
            </section>
          </div>
        )}
      </div>
    </section>
  );
}
