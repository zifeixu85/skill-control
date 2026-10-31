"use client";

import type { ReactNode } from "react";
import { usePersistent } from "../../../hooks/usePersistent";
import { isInstalled } from "../../../lib/agents";
import { errorMessage } from "../../../lib/api";
import { invalidateResources } from "../../../hooks/useResource";
import { envOffline, networkPatch, noticeSeen, onboardingLaterStore, updateChecksOn } from "../../../lib/onboarding";
import { InfoIcon } from "../../icons";
import { useData } from "../../providers/DataProvider";
import { useNav } from "../../providers/NavProvider";
import { useToast } from "../../providers/ToastProvider";

/**
 * 概览 banners for first-run decisions that were put off: 常用 Agent after 稍后再说, and the
 * one-time notice that update checks go online (for people who never saw onboarding).
 */
export function FirstRunBanners() {
  const { needsOnboarding, agents, config, updateConfig } = useData();
  const { go } = useNav();
  const toast = useToast();
  const [later, setLater] = usePersistent(onboardingLaterStore);
  const anyInstalled = agents.some((agent) => isInstalled(agent));
  // The 联网 notice for whoever didn't confirm onboarding step 1: they never onboarded (older
  // configs are already marked seen), or they chose 稍后再说.
  const showNotice = Boolean(config.data) && !noticeSeen(config.data) && !envOffline(config.data) && (!needsOnboarding || later === "1");

  /** Seen: the service records it and, on a fresh install, starts its first automatic check. */
  const acknowledge = async () => {
    try {
      await updateConfig(networkPatch(updateChecksOn(config.data)));
      void invalidateResources("agent-versions");
    } catch (error) {
      toast.show(errorMessage(error, "没有保存。"), { tone: "error" });
    }
  };

  return (
    <>
      {needsOnboarding && later === "1" && anyInstalled ? (
        <section className="banner" aria-label="还没有选常用 Agent">
          <span className="banner-ic" aria-hidden="true">
            <InfoIcon />
          </span>
          <p>
            <b>还没有选常用 Agent</b>
            <span>选好后，Skill Control 会围绕它们整理技能、提醒哪里少装了。</span>
          </p>
          <button type="button" className="btn sm primary" onClick={() => setLater("")}>
            现在选择
          </button>
        </section>
      ) : null}
      {showNotice ? (
        <section className="banner" aria-label="联网检查更新">
          <span className="banner-ic" aria-hidden="true">
            <InfoIcon />
          </span>
          <p>
            <b>{updateChecksOn(config.data) ? "Skill Control 会联网检查更新" : "自动检查更新已关闭"}</b>
            <span>从 GitHub 和 npm 查 Skill Control 与各 Agent 的新版本，不上传本机数据。</span>
          </p>
          <span className="banner-acts">
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => {
                void acknowledge();
                go("settings", { section: "privacy" });
              }}
            >
              在设置里修改
            </button>
            <button type="button" className="btn sm" onClick={() => void acknowledge()}>
              知道了
            </button>
          </span>
        </section>
      ) : null}
    </>
  );
}

/** 概览 with no Agent detected: say so, name what's supported, offer a rescan. */
export function NoAgentsState({ action }: { action: ReactNode }) {
  return (
    <div className="no-agents">
      <b>没有检测到 Agent</b>
      <p>
        Skill Control 整理的是 Agent 的技能，比如 Claude Code、Codex、WorkBuddy、Gemini CLI、Cursor、Hermes Agent。装好其中一个、至少打开过一次，再重新扫描。
      </p>
      <p className="muted small">已经装了却没出现？可能是装在了不常见的位置；扫描到的候选会出现在这里，可以添加为自定义 Agent。</p>
      {action}
    </div>
  );
}
