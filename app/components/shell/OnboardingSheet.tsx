"use client";

import { useRef, useState } from "react";
import { invalidateResources } from "../../hooks/useResource";
import { initialPrimary, isInstalled } from "../../lib/agents";
import { errorMessage } from "../../lib/api";
import { joinNames } from "../../lib/format";
import { ENV_OFFLINE_TEXT, envOffline, networkPatch, noticeSeen, PRIVACY_URL, PROMISES, updateChecksOn } from "../../lib/onboarding";
import { RefreshIcon } from "../icons";
import { useData } from "../providers/DataProvider";
import { useToast } from "../providers/ToastProvider";
import { ExternalLink } from "../ui/ExternalLink";
import { Modal } from "../ui/Modal";
import { AgentPicker } from "./AgentPicker";

const SUPPORTED = "Claude Code、Codex、WorkBuddy、Gemini CLI、Cursor、Hermes Agent";

/**
 * First run (config.primaryAgentIds is null), two steps: what Skill Control reads and does,
 * with the 自动检查更新 choice; then 常用 Agent. Any way out without saving is 稍后再说.
 */
export function OnboardingSheet({ onLater }: { onLater: () => void }) {
  const { scan, config, agents, updateConfig, agentName, refresh } = useData();
  const toast = useToast();
  // Someone who already confirmed step 1 (and then chose 稍后再说) comes back to step 2.
  const [step, setStep] = useState<1 | 2>(() => (noticeSeen(config.data) ? 2 : 1));
  const [checks, setChecks] = useState(() => updateChecksOn(config.data));
  const offline = envOffline(config.data);
  const installed = agents.filter((agent) => isInstalled(agent));
  const installedIds = installed.map((agent) => agent.id);
  const suggested = initialPrimary(scan.data?.suggestedPrimaryAgentIds || [], installedIds);
  const [selected, setSelected] = useState<string[]>(suggested);
  const [saving, setSaving] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const [error, setError] = useState("");
  const decided = useRef(noticeSeen(config.data));

  /**
   * Confirming step 1 is the user seeing the 联网 notice: the service records it (and only then
   * starts automatic checks on a fresh install), together with the 自动检查更新 choice.
   */
  const saveNetwork = async () => {
    if (decided.current) return;
    decided.current = true;
    try {
      await updateConfig(networkPatch(checks));
      void invalidateResources("agent-versions");
    } catch (saveError) {
      decided.current = false;
      toast.show(errorMessage(saveError, "没有保存“自动检查更新”。"), { tone: "error" });
    }
  };

  // 稍后再说 on step 1 is not a yes to going online: nothing is sent.
  const later = () => {
    if (!saving) onLater();
  };

  const next = () => {
    void saveNetwork();
    setStep(2);
  };

  const rescan = async () => {
    setRescanning(true);
    try {
      await refresh(true);
    } finally {
      setRescanning(false);
    }
  };

  const save = async () => {
    if (!config.data || !selected.length) return;
    setSaving(true);
    setError("");
    try {
      await updateConfig({ primaryAgentIds: selected });
      toast.show(`已设为常用：${joinNames(selected.map(agentName))}`);
    } catch (saveError) {
      setError(errorMessage(saveError, "保存失败。"));
    } finally {
      setSaving(false);
    }
  };

  const footer =
    step === 1 ? (
      <>
        <small>第 1 步，共 2 步</small>
        <span className="acts-right">
          <button type="button" className="btn ghost" onClick={later}>
            稍后再说
          </button>
          <button type="button" className="btn primary" onClick={next}>
            下一步
          </button>
        </span>
      </>
    ) : (
      <>
        <small>第 2 步，共 2 步 · 之后可以在“设置”里修改</small>
        <span className="acts-right">
          <button type="button" className="btn ghost" onClick={() => setStep(1)} disabled={saving}>
            上一步
          </button>
          <button type="button" className="btn ghost" onClick={later} disabled={saving}>
            稍后再说
          </button>
          <button type="button" className="btn primary" disabled={saving || !selected.length || !installed.length} onClick={() => void save()}>
            {saving ? "正在保存…" : "开始使用"}
          </button>
        </span>
      </>
    );

  return (
    <Modal wide title={step === 1 ? "欢迎使用 Skill Control" : "你主要用哪几个 Agent？"} onClose={later} busy={saving} footer={footer}>
      {step === 1 ? (
        <div className="onb">
          <p className="onb-lead">在一个地方查看和整理各 Agent 的技能、插件和 MCP。开始前先说清楚它会做什么：</p>
          <ul className="onb-promises">
            {PROMISES.map((promise) => (
              <li key={promise.title}>
                <b>{promise.title}</b>
                <span>{promise.detail}</span>
              </li>
            ))}
          </ul>
          <label className={`onb-check ${offline ? "disabled" : ""}`}>
            <input type="checkbox" checked={checks && !offline} disabled={offline} onChange={(event) => setChecks(event.target.checked)} />
            <span>
              自动检查更新（GitHub、npm）
              <small>{offline ? ENV_OFFLINE_TEXT : "可以随时在“设置 → 数据与隐私”里关闭，关闭后不会自动联网。"}</small>
            </span>
          </label>
          <p className="muted small">
            读取哪些位置、保存什么、怎么删除，见
            <ExternalLink className="md-link" href={PRIVACY_URL}>
              隐私说明
            </ExternalLink>
            。
          </p>
        </div>
      ) : !installed.length ? (
        <div className="onb-empty" role="status">
          <b>没有检测到 Agent</b>
          <p>Skill Control 支持 {SUPPORTED} 等。装好其中一个、至少打开过一次，再点“重新检测”。</p>
          <button type="button" className="btn" disabled={rescanning} onClick={() => void rescan()}>
            <RefreshIcon className={rescanning ? "spin" : ""} />
            {rescanning ? "正在检测…" : "重新检测"}
          </button>
        </div>
      ) : (
        <div className="onb">
          <p className="onb-lead">
            {suggested.length
              ? `根据最近 30 天的会话记录，推荐了 ${joinNames(suggested.map(agentName))}。`
              : "还没有足够的会话记录来推荐，挑你最常用的就好。"}
            Skill Control 会围绕你选的 Agent 整理技能，其他 Agent 照常显示，但不会提醒你安装。
          </p>
          <AgentPicker name="primary-onboarding" selected={selected} onChange={setSelected} onLimit={(message) => toast.show(message)} disabled={saving} />
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
