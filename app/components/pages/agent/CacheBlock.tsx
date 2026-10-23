"use client";

import { formatRate, LOW_HIT, rateTone, type CacheDistribution } from "../../../lib/cache";
import { CacheHint } from "../usage/TotalsStrip";

/**
 * 对话缓存命中率: the median conversation, the middle 80% as a bar (p10–p90) and how many
 * conversations stay below 50%. Falls back to the overall rate when there is no spread.
 */
export function CacheBlock({ rate, distribution, agentName }: { rate: number | null; distribution: CacheDistribution | null; agentName: string }) {
  if (!distribution && rate === null) return null;
  return (
    <section className="usage-block cache-block" aria-labelledby="cache-block-title">
      <h3 id="cache-block-title" className="with-hint">
        对话缓存命中率
        <CacheHint />
      </h3>
      {distribution ? (
        <>
          <div className="cache-head">
            <b className={`cache-median ${rateTone(distribution.median)}`}>{formatRate(distribution.median)}</b>
            <span>
              中位数 · {distribution.sessions.toLocaleString("zh-CN")} 个对话
              {rate !== null ? ` · 整体 ${formatRate(rate)}` : ""}
            </span>
          </div>
          <div
            className="cache-range"
            role="img"
            aria-label={`${agentName} 的对话缓存命中率：中位数 ${formatRate(distribution.median)}，多数对话在 ${formatRate(distribution.p10)} 到 ${formatRate(distribution.p90)} 之间`}
          >
            <span className="cache-track" aria-hidden="true">
              <i className="cache-low" style={{ width: `${LOW_HIT * 100}%` }} />
              <i className="cache-band" style={{ left: `${distribution.p10 * 100}%`, width: `${Math.max(0.5, (distribution.p90 - distribution.p10) * 100)}%` }} />
              <i className="cache-mid" style={{ left: `${distribution.median * 100}%` }} />
            </span>
            <span className="cache-scale" aria-hidden="true">
              <span>0%</span>
              <span>50%</span>
              <span>100%</span>
            </span>
          </div>
          <p className="muted small">
            {formatRate(distribution.p10) === formatRate(distribution.p90)
              ? `大多数对话都在 ${formatRate(distribution.median)} 左右。`
              : `多数对话（中间 80%）在 ${formatRate(distribution.p10)}–${formatRate(distribution.p90)} 之间。`}
            {distribution.lowSessions ? (
              <b className="cache-low-count"> {distribution.lowSessions} 个对话低于 50%</b>
            ) : (
              " 没有低于 50% 的对话。"
            )}
            {distribution.excluded ? ` 另有 ${distribution.excluded} 个对话太短或没有缓存信息，没有计入。` : ""}
          </p>
        </>
      ) : (
        <div className="cache-head">
          <b className={`cache-median ${rateTone(rate)}`}>{formatRate(rate)}</b>
          <span>整体 · 按对话的分布暂时没有</span>
        </div>
      )}
    </section>
  );
}
