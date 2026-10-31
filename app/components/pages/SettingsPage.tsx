"use client";

import { usePersistent } from "../../hooks/usePersistent";
import { useScrollMemory } from "../../hooks/useScrollMemory";
import { errorMessage } from "../../lib/api";
import { joinNames } from "../../lib/format";
import { persistentStore } from "../../lib/storage";
import { detectedHint } from "../../lib/agents";
import { installMethod, type InstallMethod } from "../../lib/install-scope";
import type { ManagerConfig } from "../../lib/types";
import { useData } from "../providers/DataProvider";
import { useToast } from "../providers/ToastProvider";
import { useNav } from "../providers/NavProvider";
import { AgentPicker } from "../shell/AgentPicker";
import { HistoryList } from "./settings/HistoryList";
import { AgentVersionsSetting } from "./settings/AgentVersionsSetting";
import { IntegrationSection } from "./settings/IntegrationSection";
import { PrivacySection } from "./settings/PrivacySection";
import { AboutSection, AppUpdateSetting } from "./settings/AboutSection";
import { SettingsNav, useSectionSpy } from "./settings/SettingsNav";
import { NewAgentsNotice } from "./home/NewAgentsNotice";
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
  const { go } = useNav();
  const toast = useToast();
  const { write, saving } = useConfigWriter();
  const [theme, setTheme] = usePersistent(themeStore);
  const scrollRef = useScrollMemory<HTMLDivElement>("settings");
  const method: InstallMethod = installMethod(config.data);
  // A pre-0.3 config moved to the library method keeps a note until the user picks.
  const migratedFrom = config.data?.library?.installModeMigrated?.from || null;
  const setMethod = (installMode: InstallMethod, message: string) => void write({ library: { installMode } }, message);
  const visible = config.data?.visibleAgentIds || [];
  // Until the user customizes it, every detected Agent is read.
  const customized = config.data?.visibleCustomized !== false;
  const { current, showSection } = useSectionSpy(Boolean(config.data && scan.data));

  return (
    <section className="page" aria-labelledby="page-title">
      <TopBar title={<span id="page-title">设置</span>} />
      <div className="scroll" ref={scrollRef}>
        {!config.data || !scan.data ? (
          <Loading rows={6} />
        ) : (
          <div className="settings-layout">
            <SettingsNav current={current} onPick={showSection} />
            <div className="set-grid">
              <div className="set-group" id="set-group-agents" data-section="agents">
                <NewAgentsNotice place="settings" />
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
                <section className="set-block" aria-labelledby="set-visible">
                  <h2 id="set-visible">读取哪些 Agent 的技能</h2>
                  <p>
                    没勾选的 Agent 只统计数量，不读取技能内容，也不会出现在技能列表里。常用 Agent 总会读取。
                    {customized ? "" : "目前读取全部检测到的 Agent。"}
                  </p>
                  <div className="check-grid">
                    {agents
                      .filter((agent) => agent.available)
                      .map((agent) => {
                        const locked = primary.includes(agent.id);
                        const on = locked || !customized || visible.includes(agent.id);
                        return (
                          <label key={agent.id} className={locked ? "locked" : ""} title={detectedHint(agent.detectedBy, 4) || undefined}>
                            <input
                              type="checkbox"
                              checked={on}
                              disabled={locked || saving}
                              onChange={(event) => {
                                const shown = customized ? visible : agents.filter((item) => item.available).map((item) => item.id);
                                const next = event.target.checked
                                  ? [...new Set([...shown, agent.id])]
                                  : shown.filter((id) => id !== agent.id);
                                void write(
                                  { visibleAgentIds: next, visibleCustomized: true },
                                  event.target.checked ? `开始读取 ${agent.name} 的技能` : `不再读取 ${agent.name} 的技能`,
                                );
                              }}
                            />
                            <AgentAvatar id={agent.id} size="sm" />
                            <span>{agent.name}</span>
                            <small>{agent.skillsDir === "missing" ? "还没有技能" : `${agent.skillCount} 个`}</small>
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
              </div>
              <div className="set-group" id="set-group-mode" data-section="mode">
                <section className="set-block" aria-labelledby="set-mode">
                  <h2 id="set-mode">安装方式</h2>
                  <p>导入技能、从一个 Agent 装到其他 Agent 时默认怎么做。每次安装时还可以再选范围。</p>
                  {migratedFrom === "copy" ? (
                    <p className="inline-note">从旧版本升级：以前的默认是“复制”，现在默认改为统一技能库。想继续各装一份，选下面的「各装一份」。</p>
                  ) : null}
                  <div className="radio-row">
                    <Choice
                      name="sync-mode"
                      value="library"
                      current={method}
                      disabled={saving}
                      title="统一技能库（推荐）"
                      detail="技能放进 ~/.agents/skills 只存一份：会自动读取技能库的 Agent 直接能用，其他的逐个接入。在库里更新一次，大家都用新版本"
                      onSelect={() => setMethod("library", "安装方式改为统一技能库")}
                    />
                    <Choice
                      name="sync-mode"
                      value="per-agent"
                      current={method}
                      disabled={saving}
                      title="各装一份"
                      detail="复制到每个 Agent 自己的技能目录，各自独立；更新时要逐个更新。替换前自动备份"
                      onSelect={() => setMethod("per-agent", "安装方式改为各装一份")}
                    />
                  </div>
                </section>
                <section className="set-block" aria-labelledby="set-history">
                  <h2 id="set-history">历史与撤销</h2>
                  <p>
                    每次安装、导入、更新、移除和整理都会记录下来。替换前的旧版本保存在 <code>~/.agent-skill-manager/backups</code>，
                    移除的技能在 <button type="button" className="link-btn" onClick={() => go("library")}>技能库 → 回收站</button>。
                  </p>
                  <HistoryList />
                </section>
              </div>
              <div className="set-group" id="set-group-integration" data-section="integration">
                <IntegrationSection />
              </div>
              <div className="set-group" id="set-group-theme" data-section="theme">
                <section className="set-block" aria-labelledby="set-theme">
                  <h2 id="set-theme">外观</h2>
                  <div className="radio-row three">
                    <Choice name="theme" value="system" current={theme} title="跟随系统" detail="和系统的外观一致" onSelect={setTheme} />
                    <Choice name="theme" value="light" current={theme} title="浅色" detail="始终使用浅色" onSelect={setTheme} />
                    <Choice name="theme" value="dark" current={theme} title="深色" detail="始终使用深色" onSelect={setTheme} />
                  </div>
                </section>
              </div>
              <div className="set-group" id="set-group-privacy" data-section="privacy">
                <PrivacySection />
              </div>
              <div className="set-group" id="set-group-versions" data-section="versions">
                <AgentVersionsSetting />
                <AppUpdateSetting />
              </div>
              <div className="set-group" id="set-group-about" data-section="about">
                <AboutSection />
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
