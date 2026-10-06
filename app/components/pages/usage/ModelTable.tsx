"use client";

import { isUnsupported, useResource } from "../../../hooks/useResource";
import { api, errorMessage } from "../../../lib/api";
import {
  basisChip,
  BASIS_HINTS,
  BASIS_LABELS,
  COST_HINT,
  estimatedPart,
  formatCost,
  longShareLabel,
  priceTarget,
  type ModelRow,
  type ModelsReport,
} from "../../../lib/cost";
import { formatCompact } from "../../../lib/format";
import { useData } from "../../providers/DataProvider";
import { useNav } from "../../providers/NavProvider";
import { AgentAvatar } from "../../ui/Avatar";
import { Loading } from "../../ui/basics";
import { ItemText } from "../../ui/Item";

function Banners({ report, onOpen }: { report: ModelsReport; onOpen: (row?: string) => void }) {
  const names = new Map(report.models.map((row) => [row.priceRef?.id || row.model, row.name]));
  const table = report.pricingTable;
  return (
    <>
      {report.pricingStale ? (
        <p className="index-note warn" role="status">
          以下模型价格可能已变化，请核对：{report.pricingStale.ids.map((id) => names.get(id) || id).join("、")}
          {report.pricingStale.since ? `（${report.pricingStale.since} 起）` : ""}。
          <button type="button" className="link-btn" onClick={() => onOpen(`models:${report.pricingStale?.ids[0]}`)}>
            查看价格表
          </button>
        </p>
      ) : null}
      {table?.stale ? (
        <p className="index-note warn" role="status">
          价格表已超过 {table.reviewAfterDays ?? 90} 天未核对{table.checkedAt ? `（核对于 ${table.checkedAt}）` : ""}，预估费用可能不准。
        </p>
      ) : null}
      {report.unpriced.length ? (
        <p className="index-note error" role="status">
          {report.unpriced.length} 个模型价格表里没有，不计入预估费用：{report.unpriced.join("、")}
        </p>
      ) : null}
    </>
  );
}

function Row({ row }: { row: ModelRow }) {
  const { agentName } = useData();
  const { go } = useNav();
  const chip = basisChip(row.basis);
  const unpriced = row.basis === "unpriced";
  const long = longShareLabel(row.longShare);
  const meta = row.name !== row.model ? row.model : row.priceAs && !row.priceAs.startsWith("@") ? `按 ${row.priceAs} 计` : row.priceAs ? "按本机其他模型的平均单价计" : null;
  const writes = row.tokens.cacheWrite + row.tokens.cacheWrite1h;
  return (
    <tr className={unpriced ? "warn-row" : ""}>
      <th scope="row" className="cell-main">
        <ItemText
          title={row.name}
          meta={meta}
          mono={row.name !== row.model}
          desc={unpriced ? <span className="danger-text">价格表里没有这个模型</span> : long}
        />
      </th>
      <td className="cell-agents">
        <span className="avatar-row">
          {row.agents.map((agent) => (
            <span key={agent.agentId} title={`${agentName(agent.agentId)}：${formatCompact(agent.tokens)} tokens · ${formatCost(agent.costUsd)}`}>
              <AgentAvatar id={agent.agentId} size="xs" />
            </span>
          ))}
        </span>
      </td>
      <td className="num">{formatCompact(row.tokens.input)}</td>
      <td className="num">{formatCompact(row.tokens.output)}</td>
      <td className="num">{formatCompact(row.tokens.cacheRead)}</td>
      <td className="num" title={row.tokens.cacheWrite1h ? `5 分钟 ${formatCompact(row.tokens.cacheWrite)} · 1 小时 ${formatCompact(row.tokens.cacheWrite1h)}` : undefined}>
        {formatCompact(writes)}
      </td>
      <td className="num cost">{unpriced ? "—" : formatCost(row.costUsd)}</td>
      <td className="cell-tags">
        <button
          type="button"
          className={`tag chip-btn ${chip.tone === "ok" ? "" : chip.tone}`}
          title={`${BASIS_HINTS[row.basis]} · 在价格表中查看`}
          onClick={() => go("pricing", { priceRow: priceTarget(row) })}
        >
          {BASIS_LABELS[row.basis]}
        </button>
      </td>
    </tr>
  );
}

/** 按模型: every model used in the window, priced at official rates, most expensive first. */
export function ModelTable({ days }: { days: number }) {
  const models = useResource(`usage:models:${days}`, () => api.usageModels(days));
  const { go } = useNav();
  const open = (row?: string) => go("pricing", row ? { priceRow: row } : {});
  if (isUnsupported(models.error)) return <p className="muted small">本地服务还没有按模型的统计，更新 Skill Control 后可以看到。</p>;
  if (models.status === "error" && !models.data) {
    return (
      <p className="form-error" role="alert">
        {errorMessage(models.error, "读取按模型的统计失败。")}
      </p>
    );
  }
  const report = models.data;
  if (!report) return <Loading label="正在按模型汇总…" rows={4} />;
  if (!report.models.length) return <p className="muted small">最近 {days} 天的会话记录里没有模型信息。</p>;
  const estimated = estimatedPart(report.totals.costBasis);
  return (
    <>
      <Banners report={report} onOpen={open} />
      <div className="matrix model-table">
        <table>
          <caption className="sr-only">最近 {days} 天各模型的用量和预估费用</caption>
          <thead>
            <tr>
              <th scope="col">模型</th>
              <th scope="col">Agents</th>
              <th scope="col" className="num">输入</th>
              <th scope="col" className="num">输出</th>
              <th scope="col" className="num">缓存读</th>
              <th scope="col" className="num">缓存写</th>
              <th scope="col" className="num" title={COST_HINT}>
                预估费用
              </th>
              <th scope="col" className="th-tags">依据</th>
            </tr>
          </thead>
          <tbody>
            {report.models.map((row) => (
              <Row key={`${row.model}:${row.basis}`} row={row} />
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={6}>
                合计{estimated ? <small className="muted"> · {estimated}</small> : null}
                {report.totals.unpricedTokens ? <small className="muted"> · 另有 {formatCompact(report.totals.unpricedTokens)} tokens 未定价</small> : null}
              </th>
              <td className="num cost" title={COST_HINT}>
                {formatCost(report.totals.costUsd)}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}
