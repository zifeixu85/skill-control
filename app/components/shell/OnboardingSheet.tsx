"use client";

import { useState } from "react";
import { useEscape } from "../../hooks/useEscape";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { Scrim } from "../ui/Scrim";
import { MAX_PRIMARY_AGENTS } from "../../lib/agents";
import { errorMessage } from "../../lib/api";
import { joinNames } from "../../lib/format";
import { useData } from "../providers/DataProvider";
import { useToast } from "../providers/ToastProvider";
import { AgentPicker } from "./AgentPicker";

/** First run: config.primaryAgentIds is null. Saving writes it through PUT /api/config. */
export function OnboardingSheet({ onDismiss }: { onDismiss: () => void }) {
  const { scan, config, updateConfig, agentName } = useData();
  const toast = useToast();
  const suggested = (scan.data?.suggestedPrimaryAgentIds || []).filter((id) =>
    scan.data?.agents.some((agent) => agent.id === id),
  );
  // Without enough activity to suggest anything, start from what the scan already uses.
  const [selected, setSelected] = useState<string[]>(
    suggested.length ? suggested : (scan.data?.effectivePrimaryAgentIds || []).slice(0, MAX_PRIMARY_AGENTS),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const ref = useFocusTrap<HTMLDivElement>();
  useEscape(true, onDismiss);

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

  return (
    <Scrim onDismiss={onDismiss} busy={saving}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="onboarding-title" ref={ref} tabIndex={-1}>
        <h2 id="onboarding-title">你主要用哪几个 Agent？</h2>
        <p>
          {suggested.length
            ? `根据最近 30 天的会话记录，推荐了 ${joinNames(suggested.map(agentName))}。`
            : "还没有足够的会话记录来推荐，先挑你最常用的就好。"}
          Skill Control 会围绕你选的 Agent 整理技能，其他 Agent 照常显示，但不会提醒你安装。
        </p>
        <AgentPicker name="primary-onboarding" selected={selected} onChange={setSelected} onLimit={(message) => toast.show(message)} disabled={saving} />
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="acts">
          <small>之后可以在“设置”里修改</small>
          <span className="acts-right">
            <button type="button" className="btn ghost" onClick={onDismiss}>
              稍后再说
            </button>
            <button type="button" className="btn primary" disabled={saving || !selected.length} onClick={save}>
              {saving ? "正在保存…" : "开始使用"}
            </button>
          </span>
        </div>
      </div>
    </Scrim>
  );
}
