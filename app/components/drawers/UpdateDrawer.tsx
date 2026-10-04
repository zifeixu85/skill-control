"use client";

import { useState } from "react";
import { useNow } from "../../hooks/useNow";
import { useResource } from "../../hooks/useResource";
import { api, errorMessage } from "../../lib/api";
import { formatMonthDay, formatRelative } from "../../lib/format";
import { STATUS_HINTS, type UnitChanges } from "../../lib/updates";
import { StatusTag, VersionLine } from "../pages/updates/UnitRow";
import { UpdateFlow } from "../pages/updates/UpdateFlow";
import { UPDATES_KEY } from "../pages/updates/UpdatesPage";
import { useData } from "../providers/DataProvider";
import { LetterLogo } from "../ui/Avatar";
import { KvTable } from "../ui/basics";
import { Drawer } from "./Drawer";

function ChangesSection({ unitKey, initial }: { unitKey: string; initial: { title: string }[] }) {
  const [state, setState] = useState<{ status: "idle" | "loading" } | { status: "ready"; changes: UnitChanges } | { status: "error"; message: string }>({
    status: "idle",
  });
  const load = async () => {
    setState({ status: "loading" });
    try {
      setState({ status: "ready", changes: await api.updateChanges(unitKey) });
    } catch (error) {
      setState({ status: "error", message: errorMessage(error, "读取改动失败。") });
    }
  };
  return (
    <section>
      <h3>改动</h3>
      {initial.length ? (
        <ul className="plain-list">
          {initial.map((change) => (
            <li key={change.title}>{change.title}</li>
          ))}
        </ul>
      ) : null}
      {state.status === "ready" ? (
        state.changes.changes.length ? (
          <ul className="change-list">
            {state.changes.changes.map((change, index) => (
              <li key={`${change.sha || index}`}>
                {change.sha ? <code>{change.sha.slice(0, 7)}</code> : null}
                <span>{change.title}</span>
                {change.date ? <em>{formatMonthDay(change.date)}</em> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">{state.changes.error || "上游没有提供改动记录。"}</p>
        )
      ) : (
        <button type="button" className="btn sm" disabled={state.status === "loading"} onClick={() => void load()}>
          {state.status === "loading" ? "正在读取…" : "查看改动"}
        </button>
      )}
      {state.status === "error" ? <p className="form-error">{state.message}</p> : null}
      <p className="footnote">查看改动会向上游发 1 个请求。</p>
    </section>
  );
}

export function UpdateDrawer({ unitKey, onClose }: { unitKey: string; onClose: () => void }) {
  const updates = useResource(UPDATES_KEY, () => api.updates());
  const { agentName } = useData();
  const now = useNow();
  const unit = updates.data?.units.find((item) => item.unitKey === unitKey);
  if (!unit) return null;
  const changeable = ["skills-cli", "claude-plugin", "codex-marketplace", "git"].includes(unit.sourceType);
  return (
    <Drawer
      label={`${unit.title} 更新`}
      icon={<LetterLogo text={unit.title} />}
      title={unit.title}
      subtitle={unit.sourceLabel || unit.sourceType}
      onClose={onClose}
      wide
    >
      <div className="insp-body">
        <div className="inside">
          <StatusTag unit={unit} />
          <VersionLine unit={unit} />
          {unit.lockDrift ? <span className="tag mute">锁记录落后于本地内容</span> : null}
        </div>
        <p className="desc">{STATUS_HINTS[unit.status]}</p>
        {unit.error ? (
          <p className="form-error" role="alert">
            {unit.error.message}
            {unit.error.resetAt ? `（${formatMonthDay(unit.error.resetAt)} 后可重试）` : ""}
          </p>
        ) : null}
        {unit.instances.length ? (
          <section>
            <h3>装在 {unit.instances.length} 个位置</h3>
            <div className="copies">
              {unit.instances.map((instance) => (
                <div key={`${instance.agentId}-${instance.path}`}>
                  <code title={instance.path}>{instance.path}</code>
                  <em>{agentName(instance.agentId)}</em>
                  <em />
                </div>
              ))}
            </div>
          </section>
        ) : null}
        <section>
          <h3>详情</h3>
          <KvTable
            rows={[
              { label: "来源", value: unit.sourceLabel || unit.sourceType },
              { label: "管理方", value: unit.owner === "skill-control" ? "Skill Control" : unit.owner.startsWith("host:") ? unit.owner.slice(5) : "未知" },
              { label: "当前", value: unit.current || "" },
              { label: "最新", value: unit.latest || "" },
              { label: "可能的来源", value: unit.possibleSource || "" },
              { label: "上次检查", value: unit.checkedAt && now ? formatRelative(unit.checkedAt, now) : "" },
              { label: "说明", value: unit.reason || "" },
            ]}
          />
        </section>
        {unit.binaries.length ? (
          <section>
            <h3>本机上的命令</h3>
            <div className="copies">
              {unit.binaries.map((binary) => (
                <div key={binary.path}>
                  <code>{binary.path}</code>
                  <em>{binary.version}</em>
                  <em>{binary.hermes ? "Hermes 自带，不会被更新" : ""}</em>
                </div>
              ))}
            </div>
          </section>
        ) : null}
        {changeable || unit.changes.length ? <ChangesSection unitKey={unit.unitKey} initial={unit.changes} /> : null}
        <UpdateFlow key={unit.unitKey} unit={unit} />
      </div>
    </Drawer>
  );
}
