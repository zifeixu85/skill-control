"use client";

import { useNow } from "../../../hooks/useNow";
import { isUnsupported, useResource } from "../../../hooks/useResource";
import { formatDateTime, formatRelative } from "../../../lib/format";
import { useNav } from "../../providers/NavProvider";
import { AGENT_VERSIONS_KEY, loadAgentVersions } from "../updates/AgentVersions";

/** 设置 · Agent 版本检查: when it last ran and that it runs once a day on its own. */
export function AgentVersionsSetting() {
  const report = useResource(AGENT_VERSIONS_KEY, loadAgentVersions);
  const now = useNow();
  const { go } = useNav();
  if (isUnsupported(report.error)) return null;
  const data = report.data;
  const last = data?.checkedAt ? `${formatDateTime(data.checkedAt)}${now ? `（${formatRelative(data.checkedAt, now)}）` : ""}` : "还没有检查过";
  return (
    <section className="set-block" aria-labelledby="set-agent-versions">
      <h2 id="set-agent-versions">Agent 版本检查</h2>
      <p>
        每天自动检查一次各 Agent 有没有新版本，只读取官方 npm、应用更新源等公开信息，不会自动安装任何东西。结果在{" "}
        <button type="button" className="link-btn" onClick={() => go("updates")}>
          更新 → Agent 软件
        </button>
        。
      </p>
      <dl className="kv">
        <div className="kv-row">
          <dt className="k">上次检查</dt>
          <dd>{data ? last : report.status === "error" ? "读取失败" : "正在读取…"}</dd>
        </div>
        {data?.nextCheckAt && !data.offline ? (
          <div className="kv-row">
            <dt className="k">下次检查</dt>
            <dd>{formatDateTime(data.nextCheckAt)}</dd>
          </div>
        ) : null}
        {data?.offline ? (
          <div className="kv-row">
            <dt className="k">状态</dt>
            <dd>离线模式，不联网检查</dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}
