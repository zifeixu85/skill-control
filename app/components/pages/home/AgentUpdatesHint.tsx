"use client";

import { useResource } from "../../../hooks/useResource";
import { agentsWithUpdates } from "../../../lib/agent-versions";
import { joinNames } from "../../../lib/format";
import { UpdateIcon } from "../../icons";
import { useData } from "../../providers/DataProvider";
import { useNav } from "../../providers/NavProvider";
import { AGENT_VERSIONS_KEY, loadAgentVersions } from "../updates/AgentVersions";

/** A quiet line under the cards when a 常用 Agent has a newer version out. */
export function AgentUpdatesHint() {
  const { primary } = useData();
  const { go } = useNav();
  const report = useResource(AGENT_VERSIONS_KEY, loadAgentVersions);
  const pending = agentsWithUpdates(report.data, primary);
  if (!pending.length) return null;
  const single = pending.length === 1 ? pending[0] : null;
  return (
    <p className="quiet-hint" role="status">
      <UpdateIcon aria-hidden="true" />
      <span>
        {single
          ? `${single.name} 有新版本${single.latest ? ` ${single.latest.version}` : ""}（你装的是 ${single.installed?.version || "未知版本"}）`
          : `${joinNames(pending.map((agent) => agent.name))} 有新版本`}
      </span>
      <button type="button" className="link-btn" onClick={() => go("updates")}>
        查看
      </button>
    </p>
  );
}
