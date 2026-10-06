"use client";

import { useEffect, useRef } from "react";
import { isUnsupported, useResource } from "../../../hooks/useResource";
import { useScrollMemory } from "../../../hooks/useScrollMemory";
import { api, errorMessage } from "../../../lib/api";
import { groupByVendor, nameOf, priceRowId, usedPriceIds, type PricingTable } from "../../../lib/pricing";
import { revealInPage } from "../../../lib/reveal";
import { takePriceTarget, useNav } from "../../providers/NavProvider";
import { EmptyState, Loading, SectionHeading, TopBar } from "../../ui/basics";
import { EstimateTables } from "./EstimateTables";
import { VendorTable } from "./PriceTable";

/** Days of usage that count as "本机在用". */
const USED_DAYS = 90;

const reveal = (target: string) => revealInPage(document.getElementById(target === "rules" ? "price-rules" : priceRowId(target)));

function Rules() {
  return (
    <section className="price-rules" id="price-rules" aria-labelledby="price-rules-title">
      <SectionHeading id="price-rules-title" title="统计规则" />
      <ul>
        <li>订阅（Claude Max、ChatGPT Pro、WorkBuddy 会员等）里的用量也按 API 价格折算，是“API 等价”估算，不等于实际支出。</li>
        <li>Claude 的缓存写入分 5 分钟和 1 小时两档；日志没有拆分时全部按 5 分钟计。</li>
        <li>长上下文：单次请求的提示（未缓存输入 + 缓存读 + 缓存写）超过门槛时，整次请求的所有 token 都按长上下文价计。</li>
        <li>DeepSeek 按请求时间区分峰谷，非峰时段按半价；中国法定节假日也是半价，这里不区分节假日。</li>
        <li>Batch、优先 / 弹性服务档、区域加价和缓存存储费都不计入。</li>
        <li>Claude 的快速模式只在日志标记了 fast 时按倍数计。</li>
        <li>没有模型信息的会话（如部分 Hermes / OpenClaw 记录）沿用产品自报的费用，标“产品自报”；价格表里没有、也匹配不到系列的模型标“未定价”，不计入费用。</li>
        <li>价格以核对日期为准；促销价和预览价带复核日，过期后会提示“价格待核对”。</li>
      </ul>
    </section>
  );
}

function Banners({ table }: { table: PricingTable }) {
  return (
    <>
      {table.tableStale ? (
        <p className="index-note warn" role="status">
          价格表已超过 {table.reviewAfterDays ?? 90} 天未核对（核对于 {table.checkedAt}），预估费用可能不准。
        </p>
      ) : null}
      {table.pricingStale ? (
        <p className="index-note warn" role="status">
          以下模型价格可能已变化，请核对：{table.pricingStale.ids.map((id) => nameOf(table, id)).join("、")}
          {table.pricingStale.since ? `（${table.pricingStale.since} 起）` : ""}。
        </p>
      ) : null}
    </>
  );
}

/** 模型价格表: the official prices, estimate rules and counting rules behind 预估费用. */
export function PricingPage() {
  const { go } = useNav();
  const scrollRef = useScrollMemory<HTMLDivElement>("pricing");
  const pricing = useResource("usage:pricing", () => api.usagePricing());
  const models = useResource(`usage:models:${USED_DAYS}`, () => api.usageModels(USED_DAYS));
  const pending = useRef<string | null | undefined>(undefined);
  const table = pricing.data;

  // Arriving from a 依据 chip: once the table is drawn, bring that row into view.
  useEffect(() => {
    if (pending.current === undefined) pending.current = takePriceTarget();
    if (!table || !pending.current) return;
    const target = pending.current;
    pending.current = null;
    window.requestAnimationFrame(() => reveal(target));
  }, [table]);

  const used = usedPriceIds(models.data?.models || []);
  const groups = table ? groupByVendor(table, used) : [];
  const usedCount = groups.reduce((sum, group) => sum + group.usedCount, 0);
  const cny = table?.fx.find((rate) => rate.currency === "CNY");

  return (
    <section className="page" aria-labelledby="page-title">
      <TopBar
        title={<span id="page-title">模型价格表</span>}
        sub="各厂商官方 API 价格，用来估算各 Agent 的费用"
        leading={
          <button type="button" className="btn ghost sm back" onClick={() => go("usage")}>
            ‹ 数据
          </button>
        }
      >
        <button type="button" className="btn ghost" onClick={() => reveal("rules")}>
          统计规则
        </button>
      </TopBar>
      <div className="scroll" ref={scrollRef}>
        {isUnsupported(pricing.error) ? (
          <EmptyState title="本地服务还没有价格表">更新 Skill Control 后可以看到预估费用所用的各厂商官方价格。</EmptyState>
        ) : pricing.status === "error" && !table ? (
          <EmptyState tone="error" title="读取价格表失败">
            {errorMessage(pricing.error)}
          </EmptyState>
        ) : !table ? (
          <Loading label="正在读取价格表…" rows={6} />
        ) : (
          <>
            <Banners table={table} />
            <div className="formula">
              <p>
                <b>预估费用</b> = 未缓存输入 × 输入价 + 输出 × 输出价 + 缓存读 × 缓存读价 + 缓存写 × 缓存写价
              </p>
              <small>
                单位 {table.currency} / 1M tokens · 价格核对于 {table.checkedAt || "未知"}
                {cny ? ` · 只有人民币价的模型按 1 美元 ≈ ${cny.perUsd} 元换算` : ""} · 灰色价格表示官方没有单列，按规则沿用输入价或缓存写入价
              </small>
            </div>
            <SectionHeading title="官方价目" note={`${table.models.length} 个模型${usedCount ? ` · 本机在用 ${usedCount} 个（最近 ${USED_DAYS} 天）` : ""}`} />
            {groups.map((group) => (
              <VendorTable key={group.id} group={group} table={table} used={used} />
            ))}
            <SectionHeading title="估算口径" note="官方没有单独定价的模型，以及价格表里没有的 id 怎么估" />
            <EstimateTables table={table} used={used} onShow={reveal} />
            <Rules />
          </>
        )}
      </div>
    </section>
  );
}
