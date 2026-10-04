"use client";

import { useState } from "react";
import { commandLines, fixReason, type CliApplyResult, type CliFix } from "../../../lib/cli-tools";
import { CopyPathButton } from "../../files/ConfigDetailView";
import { useData } from "../../providers/DataProvider";
import { AgentAvatar } from "../../ui/Avatar";
import { CliFixReview } from "./CliFixReview";

/** Guide text: prose stays prose, lines that are shell commands get a copy button. */
function Commands({ text }: { text: string }) {
  const commands = commandLines(text);
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!commands.size) return <p>{text}</p>;
  return (
    <div className="command-copy">
      {lines.map((line, index) =>
        commands.has(line) ? (
          <div key={`cmd-${index}`} className="command-line">
            <code className="command">{line}</code>
            <CopyPathButton path={line} label="复制命令" />
          </div>
        ) : (
          <p key={`text-${index}`}>{line}</p>
        ),
      )}
    </div>
  );
}

function Done({ result }: { result: CliApplyResult }) {
  return (
    <div className="plan-list" role="status">
      {result.changed.map((change) => (
        <p key={change.path}>
          <span className="tag">已写入</span> <code>{change.path}</code>
          {change.backup ? (
            <span className="muted">
              {" "}
              · 备份 <code>{change.backup}</code>
            </span>
          ) : null}
        </p>
      ))}
      {!result.changed.length ? <p className="muted">没有需要写入的文件。</p> : null}
    </div>
  );
}

/** One fix: guidance with copyable commands, or plan → diff → confirm → result. */
export function CliFixCard({ toolId, fix, agentIds }: { toolId: string; fix: CliFix; agentIds: string[] }) {
  const { agentName } = useData();
  const [reviewing, setReviewing] = useState(false);
  const [done, setDone] = useState<CliApplyResult | null>(null);
  const reason = fixReason(fix, agentIds, agentName);
  // A result or an open review stays on screen even if the fix stops being applicable.
  const body = done ? (
    <Done result={done} />
  ) : reviewing ? (
    <CliFixReview toolId={toolId} fix={fix} onCancel={() => setReviewing(false)} onDone={setDone} />
  ) : fix.kind === "guide" ? (
    fix.instructions ? <Commands text={fix.instructions} /> : null
  ) : fix.applicable ? (
    <div>
      <button type="button" className="btn sm" onClick={() => setReviewing(true)}>
        查看要改什么
      </button>
    </div>
  ) : null;

  return (
    <div className={`fix-card ${fix.applicable || reviewing || done ? "" : "off"}`}>
      <b>{fix.label}</b>
      {reason ? <p>{reason}</p> : null}
      {fix.agentIds.length ? (
        <span className="fix-agents" aria-label={`涉及 ${fix.agentIds.map(agentName).join("、")}`}>
          {fix.agentIds.map((id) => (
            <AgentAvatar key={id} id={id} size="xs" />
          ))}
        </span>
      ) : null}
      {body}
    </div>
  );
}
