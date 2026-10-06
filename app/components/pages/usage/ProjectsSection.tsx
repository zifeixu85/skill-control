"use client";

import { isUnsupported, useResource } from "../../../hooks/useResource";
import { api, errorMessage } from "../../../lib/api";
import { Loading } from "../../ui/basics";
import { ProjectTable } from "./ProjectTable";

/** 按项目: estimated cost per project folder across every Agent; follows the page's 7 / 30 / 90 days. */
export function ProjectsSection({ days }: { days: number }) {
  const projects = useResource(`usage:projects:${days}`, () => api.usageProjects(days));
  if (isUnsupported(projects.error)) return <p className="muted small">本地服务还没有按项目的统计，更新 Skill Control 后可以看到。</p>;
  if (projects.status === "error" && !projects.data) {
    return (
      <p className="form-error" role="alert">
        {errorMessage(projects.error, "读取按项目的统计失败。")}
      </p>
    );
  }
  const report = projects.data;
  if (!report) return <Loading label="正在按项目汇总…" rows={4} />;
  if (!report.projects.length) return <p className="muted small">最近 {days} 天的会话记录里没有项目信息。</p>;
  return (
    <ProjectTable
      projects={report.projects}
      other={report.other}
      totalCost={report.totals.costUsd}
      showAgents
      caption={`最近 ${days} 天各项目的预估费用`}
    />
  );
}
