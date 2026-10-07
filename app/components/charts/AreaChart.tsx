"use client";

import { useId, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useElementWidth } from "../../hooks/useElementWidth";
import { areaPath, linePath, niceMax, plotPoints, ticks, type ChartBox } from "../../lib/chart";
import { formatCompact } from "../../lib/format";
import { Modal } from "../ui/Modal";

export interface SeriesPoint {
  label: string;
  value: number;
}

const BOX: ChartBox = { width: 560, height: 168, top: 12, right: 12, bottom: 24, left: 40 };

/**
 * Single-series area chart drawn to scale from zero. Hover or arrow keys move a
 * crosshair; the tooltip names the day and value. Color comes from the --chart token.
 */
export function AreaChart({
  points,
  unit,
  label,
  compact,
  format,
  periodLabel,
}: {
  points: SeriesPoint[];
  unit: string;
  label: string;
  compact?: boolean;
  /** Value text for axis, tooltip and table (default: counts). Money charts may go below 1. */
  format?: (value: number) => string;
  /** Heading of the first table column: 日期 / 周 / 月. */
  periodLabel?: string;
}) {
  const [tableOpen, setTableOpen] = useState(false);
  const text = format || ((value: number) => value.toLocaleString("zh-CN"));
  const tickText = format || formatCompact;
  const id = useId();
  const [active, setActive] = useState<number | null>(null);
  // Draw at the real pixel width so text and strokes keep their size at any card width.
  const [plotRef, measured] = useElementWidth<HTMLDivElement>(BOX.width);
  const box = { ...BOX, width: Math.max(240, measured), height: compact ? 120 : measured > 720 ? 200 : BOX.height };
  const values = points.map((point) => point.value);
  const max = niceMax(Math.max(0, ...values), format ? 0.01 : 1);
  const plotted = plotPoints(values, box, max);
  const baseline = box.height - box.bottom;
  const innerWidth = box.width - box.left - box.right;
  const step = points.length > 1 ? innerWidth / (points.length - 1) : innerWidth;
  const pick = (event: PointerEvent<SVGRectElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * innerWidth;
    setActive(Math.max(0, Math.min(points.length - 1, Math.round(x / (step || 1)))));
  };
  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 1 : -1;
    setActive((current) => Math.max(0, Math.min(points.length - 1, (current ?? points.length - 1) + delta)));
  };
  const current = active !== null ? plotted[active] : null;
  const tickValues = ticks(max, 2);
  const lastIndex = points.length - 1;

  if (!points.length) return null;
  return (
    <figure className="chart">
      <div className="chart-plot" ref={plotRef}>
        <svg
          viewBox={`0 0 ${box.width} ${box.height}`}
          role="img"
          aria-labelledby={`${id}-title`}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onBlur={() => setActive(null)}
        >
          <title id={`${id}-title`}>{label}</title>
          {tickValues.map((tick) => {
            const y = baseline - (tick / max) * (baseline - box.top);
            return (
              <g key={tick} className="chart-grid">
                <line x1={box.left} x2={box.width - box.right} y1={y} y2={y} />
                <text x={box.left - 6} y={y + 3.5} textAnchor="end">
                  {tickText(tick)}
                </text>
              </g>
            );
          })}
          <path className="chart-area" d={areaPath(plotted, baseline)} />
          <path className="chart-line" d={linePath(plotted)} />
          <text className="chart-axis" x={box.left} y={box.height - 6}>
            {points[0].label}
          </text>
          <text className="chart-axis" x={box.width - box.right} y={box.height - 6} textAnchor="end">
            {points[lastIndex].label}
          </text>
          {current ? (
            <g className="chart-cursor">
              <line x1={current.x} x2={current.x} y1={box.top} y2={baseline} />
              <circle cx={current.x} cy={current.y} r={4} />
            </g>
          ) : (
            <circle className="chart-end" cx={plotted[lastIndex].x} cy={plotted[lastIndex].y} r={4} />
          )}
          <rect
            className="chart-hit"
            x={box.left}
            y={box.top}
            width={innerWidth}
            height={baseline - box.top}
            onPointerMove={pick}
            onPointerDown={pick}
            onPointerLeave={() => setActive(null)}
          />
        </svg>
        {current && active !== null ? (
          <div
            className="chart-tip"
            style={{
              left: `${(current.x / box.width) * 100}%`,
              top: `${(current.y / box.height) * 100}%`,
            }}
            role="status"
          >
            <b>{text(points[active].value)}</b> {format ? "" : unit}
            <span>{points[active].label}</span>
          </div>
        ) : null}
      </div>
      <button type="button" className="chart-table-btn" onClick={() => setTableOpen(true)}>
        查看数据表
      </button>
      {tableOpen ? (
        <Modal title={label} onClose={() => setTableOpen(false)}>
          <div className="chart-table">
            <table>
              <thead>
                <tr>
                  <th scope="col">{periodLabel || "日期"}</th>
                  <th scope="col" className="num">
                    {unit}
                  </th>
                </tr>
              </thead>
              <tbody>
                {points.map((point) => (
                  <tr key={point.label}>
                    <td>{point.label}</td>
                    <td className="num">{text(point.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      ) : null}
    </figure>
  );
}
