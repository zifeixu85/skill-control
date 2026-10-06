"use client";

import { nameOf, priceRowId, type PricingTable } from "../../../lib/pricing";
import { useData } from "../../providers/DataProvider";
import { ItemText, TagStack } from "../../ui/Item";

/** "按 GPT-6.1 Sol" — a link that brings that model's official row into view. */
function PriceAs({ table, id, onShow }: { table: PricingTable; id: string; onShow: (target: string) => void }) {
  if (id.startsWith("@")) return <span>本机这个 Agent 其他模型的加权平均单价</span>;
  return (
    <>
      <button type="button" className="link-btn" onClick={() => onShow(`models:${id}`)}>
        {nameOf(table, id)}
      </button>
      <small className="mono muted">{id}</small>
    </>
  );
}

/** 估算口径: ids with no official price of their own, then the family fallbacks. */
export function EstimateTables({ table, used, onShow }: { table: PricingTable; used: Set<string>; onShow: (target: string) => void }) {
  const { agentName } = useData();
  return (
    <>
      <h3 className="price-sub">按指定模型估算</h3>
      <div className="matrix price-table">
        <table>
          <caption className="sr-only">官方没有单独定价的模型 id，以及按哪个模型估算</caption>
          <colgroup>
            <col style={{ width: "24%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "24%" }} />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">模型</th>
              <th scope="col" className="th-tags">标记</th>
              <th scope="col">按哪个模型估</th>
              <th scope="col">原因</th>
            </tr>
          </thead>
          {table.estimates.map((estimate) => (
            <tbody key={estimate.id} id={priceRowId(`estimates:${estimate.id}`)} className="price-row">
              <tr>
                <th scope="row" className="cell-main">
                  <ItemText title={<span className="mono">{estimate.id}</span>} titleText={estimate.id} meta={estimate.agent ? `只用于 ${agentName(estimate.agent)}` : null} />
                </th>
                <td className="cell-tags">
                  <TagStack chips={used.has(`estimates:${estimate.id}`) ? [{ id: "used", kind: "status", text: "本机在用" }] : []} />
                </td>
                <td className="price-as">
                  <PriceAs table={table} id={estimate.priceAs} onShow={onShow} />
                  {estimate.fallback ? (
                    <small className="muted">
                      没有可平均的模型时按 {nameOf(table, estimate.fallback)}
                    </small>
                  ) : null}
                </td>
                <td className="reason">{estimate.reason}</td>
              </tr>
            </tbody>
          ))}
        </table>
      </div>
      <h3 className="price-sub">系列兜底</h3>
      <p className="muted small">价格表里没有的 id，按名称匹配到系列，用该系列的代表模型估算（从上到下，先具体后宽泛）。</p>
      <div className="matrix price-table">
        <table>
          <caption className="sr-only">未知模型 id 按系列兜底的规则</caption>
          <colgroup>
            <col style={{ width: "24%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "28%" }} />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">系列</th>
              <th scope="col" className="th-tags">标记</th>
              <th scope="col">匹配</th>
              <th scope="col">按哪个模型估</th>
            </tr>
          </thead>
          {table.families.map((family) => (
            <tbody key={family.id} id={priceRowId(`families:${family.id}`)} className="price-row">
              <tr>
                <th scope="row" className="cell-main">
                  <ItemText title={family.name} meta={family.id} mono />
                </th>
                <td className="cell-tags">
                  <TagStack chips={used.has(`families:${family.id}`) ? [{ id: "used", kind: "status", text: "本机在用" }] : []} />
                </td>
                <td>
                  <code className="match">{family.match}</code>
                </td>
                <td className="price-as">
                  <PriceAs table={table} id={family.priceAs} onShow={onShow} />
                </td>
              </tr>
            </tbody>
          ))}
        </table>
      </div>
    </>
  );
}
