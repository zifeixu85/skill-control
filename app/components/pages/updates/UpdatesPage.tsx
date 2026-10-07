"use client";

import { useState } from "react";
import { useNow } from "../../../hooks/useNow";
import { usePageMemory, useReturnHighlight } from "../../../hooks/usePageMemory";
import { usePolling } from "../../../hooks/usePolling";
import { invalidateResources, isUnsupported, primeResource, useResource } from "../../../hooks/useResource";
import { useScrollMemory } from "../../../hooks/useScrollMemory";
import { api, errorMessage } from "../../../lib/api";
import { formatDateTime, formatRelative, joinNames } from "../../../lib/format";
import { groupUnits, STATUS_HINTS, STATUS_LABELS, type CheckJob, type UpdatesData, type UpdateStatus, type UpdateUnit } from "../../../lib/updates";
import { RefreshIcon } from "../../icons";
import { useToast } from "../../providers/ToastProvider";
import { EmptyState, Loading, SectionHeading, TopBar } from "../../ui/basics";
import { RemedyAllBar } from "../../ui/RemedyPanel";
import { AgentVersions } from "./AgentVersions";
import { UnitRow } from "./UnitRow";

export const UPDATES_KEY = "updates";
/** Groups with nothing to act on start folded so long lists do not bury the rest. */
const FOLDED = new Set<UpdateStatus>(["unknown-source", "managed-by-host", "up-to-date"]);
/** One progress request at a time, even if a poll tick outlasts the interval. */
let polling = false;

function CheckProgress({ job }: { job: CheckJob }) {
  const ratio = job.total ? Math.min(1, job.done / job.total) : 0;
  return (
    <div className="index-progress" role="status" aria-live="polite">
      <div>
        <b>正在检查更新…</b>
        <span>
          {job.total ? `${job.done} / ${job.total} 个来源` : "正在整理来源"}
          {job.requests ? ` · 已发出 ${job.requests} 个请求` : ""}
          {job.hosts.length ? ` · ${joinNames(job.hosts)}` : ""}
        </span>
      </div>
      <span className="progress" role="progressbar" aria-label="检查进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)}>
        <i style={{ transform: `scaleX(${ratio})` }} />
      </span>
    </div>
  );
}

function FirstCheckNote({ data }: { data: UpdatesData }) {
  return (
    <div className="inline-note first-check">
      <span>
        检查更新时会联网，只读取公开信息，访问这些地址：<b>{joinNames(data.allowedHosts)}</b>。不会上传你的技能内容，也不会自动安装任何东西。
      </span>
    </div>
  );
}

function Footer({ data }: { data: UpdatesData }) {
  const now = useNow();
  return (
    <div className="updates-footer">
      <span>{data.checkedAt ? `上次检查：${formatDateTime(data.checkedAt)}${now ? `（${formatRelative(data.checkedAt, now)}）` : ""}` : "还没有检查过"}</span>
      {data.hosts.length ? <span>访问了：{joinNames(data.hosts)}</span> : null}
      {data.github ? (
        <span>
          GitHub 剩余额度：{data.github.remaining ?? "未知"}
          {data.github.resetAt ? ` · ${formatDateTime(data.github.resetAt)} 重置` : ""}
        </span>
      ) : null}
    </div>
  );
}

/** One status group; folded groups stay open after 查看详情 → back (session memory). */
function UnitGroup({ status, units }: { status: UpdateStatus; units: UpdateUnit[] }) {
  const [open, setOpen] = usePageMemory<boolean>(`updates:expanded:${status}`, false);
  const folded = FOLDED.has(status) && !open;
  return (
    <section aria-label={STATUS_LABELS[status]}>
      <SectionHeading
        title={STATUS_LABELS[status]}
        note={`${units.length} 个 · ${STATUS_HINTS[status]}`}
        action={
          FOLDED.has(status) && open ? (
            <button type="button" className="btn sm ghost" onClick={() => setOpen(false)}>
              收起
            </button>
          ) : null
        }
      />
      {folded ? (
        <button type="button" className="btn sm ghost" onClick={() => setOpen(true)}>
          显示 {units.length} 个
        </button>
      ) : (
        <div className="ulist">
          {units.map((unit) => (
            <UnitRow key={unit.unitKey} unit={unit} />
          ))}
        </div>
      )}
    </section>
  );
}

export function UpdatesPage() {
  const updates = useResource(UPDATES_KEY, () => api.updates());
  const toast = useToast();
  const scrollRef = useScrollMemory<HTMLDivElement>("updates");
  const [job, setJob] = useState<CheckJob | null>(null);
  const activeJob = job || updates.data?.job || null;
  const running = activeJob?.state === "running";

  usePolling(running, async () => {
    if (polling) return;
    polling = true;
    try {
      const next = await api.checkStatus();
      setJob(next);
      // Partial results appear while the check is still running.
      primeResource(UPDATES_KEY, await api.updates());
      if (next.state !== "running") {
        void invalidateResources("health-report");
        toast.show(next.state === "error" ? `检查没有完成：${next.error || "未知错误"}` : "检查完成", {
          tone: next.state === "error" ? "error" : "default",
        });
      }
    } catch (error) {
      setJob(null);
      toast.show(errorMessage(error, "读取检查进度失败。"), { tone: "error" });
    } finally {
      polling = false;
    }
  }, 1_500);

  const startCheck = async () => {
    try {
      setJob(await api.checkUpdates());
    } catch (error) {
      toast.show(errorMessage(error, "无法开始检查。"), { tone: "error" });
    }
  };

  const data = updates.data;
  const groups = data ? groupUnits(data.units) : [];
  useReturnHighlight("updates", Boolean(data));

  return (
    <section className="page" aria-labelledby="page-title">
      <TopBar title={<span id="page-title">更新</span>} sub="Agent 软件、技能和插件有没有新版本；更新前都会先给你看计划，确认后才执行">
        <button type="button" className="btn primary" disabled={running || !data} onClick={() => void startCheck()}>
          <RefreshIcon className={running ? "spin" : ""} />
          {running ? "正在检查…" : "检查更新"}
        </button>
      </TopBar>
      <div className="scroll" ref={scrollRef}>
        {isUnsupported(updates.error) ? (
          <EmptyState title="本地服务还没有提供更新检测">更新 Skill Control 后，这里会列出有新版本的技能和插件。</EmptyState>
        ) : updates.status === "error" && !data ? (
          <EmptyState tone="error" title="读取更新信息失败">
            {errorMessage(updates.error)}
          </EmptyState>
        ) : !data ? (
          <Loading label="正在整理来源…" rows={6} />
        ) : (
          <>
            {running && activeJob ? <CheckProgress job={activeJob} /> : null}
            {!data.checkedAt && !running ? <FirstCheckNote data={data} /> : null}
            {activeJob?.state === "error" && !running ? (
              <p className="index-note error" role="alert">
                上次检查没有完成：{activeJob.error || "未知错误"}。已拿到的结果仍然有效。
              </p>
            ) : null}
            <RemedyAllBar remedy={data.remedyAll} what="所有待处理的更新" />
            <AgentVersions />
            <SectionHeading title="技能和插件" note="上游有没有新版本" />
            <div className="health-summary">
              {groups.map((group) => (
                <div key={group.status} className={`hs ${group.status === "update-available" ? "info" : group.status === "conflict" || group.status === "check-failed" ? "danger" : group.status === "locally-modified" ? "warn" : ""}`}>
                  <b>{group.units.length}</b>
                  <span>{STATUS_LABELS[group.status]}</span>
                </div>
              ))}
            </div>
            {!data.units.length ? <EmptyState title="没有找到可以追踪来源的技能或插件" /> : null}
            {groups.map((group) => (
              <UnitGroup key={group.status} status={group.status} units={group.units} />
            ))}
            <Footer data={data} />
          </>
        )}
      </div>
    </section>
  );
}
