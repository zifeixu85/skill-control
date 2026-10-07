"use client";

import type { ChipSpec } from "../../../lib/chips";
import {
  effectivePrice,
  formatPrice,
  formatThreshold,
  INHERITED_HINTS,
  PRICE_FIELDS,
  priceRowId,
  priceSummary,
  type PriceModel,
  type PricingTable,
  type VendorGroup,
} from "../../../lib/pricing";
import { ExternalLink } from "../../ui/ExternalLink";
import { ItemText, TagStack } from "../../ui/Item";

function modelChips(model: PriceModel, used: boolean, stale: boolean): ChipSpec[] {
  const chips: ChipSpec[] = [];
  if (used) chips.push({ id: "used", kind: "status", text: "本机在用" });
  if (stale) chips.push({ id: "stale", kind: "status", tone: "danger", text: "待核对", title: model.reviewBy ? `价格待核对：复核日 ${model.reviewBy} 已过` : "价格待核对" });
  if (model.status === "promo") chips.push({ id: "promo", kind: "kind", tone: "warn", text: "促销价", title: model.reviewBy ? `复核日 ${model.reviewBy}` : undefined });
  if (model.status === "preview") chips.push({ id: "preview", kind: "kind", tone: "info", text: "预览" });
  if (model.fast) chips.push({ id: "fast", kind: "kind", text: `快速 ×${model.fast}`, title: `快速模式按 ${model.fast} 倍计（日志标记 fast 时）` });
  return chips;
}

/** Off-peak, dated changes and notes, as muted lines under the row. */
function noteLines(model: PriceModel, table: PricingTable): string[] {
  const lines: string[] = [];
  if (model.offPeak) {
    const schedule = table.schedules[model.offPeak.schedule]?.note;
    lines.push(`非峰时段：${priceSummary(model.offPeak.prices)}${schedule ? `。${schedule}` : ""}`);
  }
  for (const change of model.changes) lines.push(`${change.from} 起：${priceSummary(change.prices)}`);
  if (model.note) lines.push(model.note);
  return lines;
}

function PriceCell({ model, field }: { model: PriceModel; field: (typeof PRICE_FIELDS)[number] }) {
  const { value, inherited } = effectivePrice(model.prices, field);
  return (
    <td className={`num ${inherited ? "inherited" : ""}`} title={inherited ? `${formatPrice(value)}：${INHERITED_HINTS[field]}` : formatPrice(value)}>
      {formatPrice(value)}
    </td>
  );
}

function ModelRows({ model, table, used, stale }: { model: PriceModel; table: PricingTable; used: boolean; stale: boolean }) {
  const lines = noteLines(model, table);
  const aliases = model.aliases.length ? `别名：${model.aliases.join("、")}` : undefined;
  return (
    <tbody id={priceRowId(`models:${model.id}`)} className="price-row">
      <tr>
        <th scope="row" className="cell-main">
          <ItemText
            title={model.name}
            meta={<span title={aliases}>{model.aliases.length ? `${model.id} · 别名 ${model.aliases.length}` : model.id}</span>}
            mono
          />
        </th>
        <td className="cell-tags">
          <TagStack chips={modelChips(model, used, stale)} />
        </td>
        {PRICE_FIELDS.map((field) => (
          <PriceCell key={field} model={model} field={field} />
        ))}
        <td
          className="long"
          title={model.long ? `提示超过 ${formatThreshold(model.long.above)} 时整次请求按此价：${priceSummary(model.long.prices)}` : undefined}
        >
          {model.long ? (
            <>
              <b>&gt;{formatThreshold(model.long.above)}</b>
              <span>{priceSummary(model.long.prices, ["input", "output"])}</span>
            </>
          ) : (
            <span className="none">—</span>
          )}
        </td>
        <td className="source">
          {model.source ? (
            <ExternalLink href={model.source} title={model.source}>
              官方
            </ExternalLink>
          ) : (
            <span className="none">—</span>
          )}
        </td>
      </tr>
      {lines.length ? (
        <tr className="price-note">
          <td colSpan={9}>
            {lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </td>
        </tr>
      ) : null}
    </tbody>
  );
}

/** One vendor's official prices; the models used on this machine come first. */
export function VendorTable({ group, table, used }: { group: VendorGroup; table: PricingTable; used: Set<string> }) {
  const stale = new Set(table.pricingStale?.ids || []);
  return (
    <section className="price-vendor" aria-labelledby={`vendor-${group.id}`}>
      <h3 id={`vendor-${group.id}`}>
        {group.pricingUrl ? (
          <ExternalLink href={group.pricingUrl}>{group.name}</ExternalLink>
        ) : (
          group.name
        )}
        <em>
          {group.models.length} 个模型{group.usedCount ? ` · 本机在用 ${group.usedCount}` : ""}
        </em>
      </h3>
      <div className="matrix price-table">
        <table>
          <caption className="sr-only">{group.name} 官方价目（USD / 1M tokens）</caption>
          {/* Fixed widths, so every vendor's columns line up down the page. */}
          <colgroup>
            <col style={{ width: "23%" }} />
            <col style={{ width: "12%" }} />
            {PRICE_FIELDS.map((field) => (
              <col key={field} style={{ width: "7.5%" }} />
            ))}
            <col style={{ width: "19%" }} />
            <col style={{ width: "8.5%" }} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">模型</th>
              <th scope="col" className="th-tags">标记</th>
              <th scope="col" className="num">输入</th>
              <th scope="col" className="num">输出</th>
              <th scope="col" className="num">缓存读</th>
              <th scope="col" className="num">缓存写</th>
              <th scope="col" className="num">
                1 小时
                <br />
                缓存写
              </th>
              <th scope="col">长上下文</th>
              <th scope="col">来源</th>
            </tr>
          </thead>
          {group.models.map((model) => (
            <ModelRows key={model.id} model={model} table={table} used={used.has(`models:${model.id}`)} stale={stale.has(model.id)} />
          ))}
        </table>
      </div>
    </section>
  );
}
