/** Geometry for the hand-rolled SVG charts. Values map linearly from zero (no truncated axes). */

export interface ChartBox {
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ChartPoint {
  x: number;
  y: number;
  value: number;
}

/** A rounded upper bound with 1/2/2.5/5 × 10ⁿ steps; never below 1. */
export function niceMax(value: number): number {
  if (!(value > 0)) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= step * base) return step * base;
  }
  return 10 * base;
}

/** Evenly spaced gridline values from 0 to max; small integer ranges never get fractional ticks. */
export function ticks(max: number, count = 3): number[] {
  if (max <= count && Number.isInteger(max)) {
    return Array.from({ length: max + 1 }, (_, index) => index);
  }
  const values: number[] = [];
  for (let index = 0; index <= count; index += 1) values.push((max / count) * index);
  const fractional = max < 10 && values.some((value) => !Number.isInteger(value));
  return fractional ? [0, max] : values;
}

export function plotPoints(values: number[], box: ChartBox, max = niceMax(Math.max(0, ...values))): ChartPoint[] {
  const innerWidth = box.width - box.left - box.right;
  const innerHeight = box.height - box.top - box.bottom;
  const step = values.length > 1 ? innerWidth / (values.length - 1) : 0;
  return values.map((value, index) => ({
    x: box.left + (values.length > 1 ? index * step : innerWidth / 2),
    y: box.top + innerHeight - (Math.max(0, value) / max) * innerHeight,
    value,
  }));
}

const round = (value: number) => Math.round(value * 100) / 100;

export function linePath(points: ChartPoint[]): string {
  return points.map((point, index) => `${index ? "L" : "M"}${round(point.x)} ${round(point.y)}`).join(" ");
}

export function areaPath(points: ChartPoint[], baseline: number): string {
  if (!points.length) return "";
  const first = points[0];
  const last = points[points.length - 1];
  return `${linePath(points)} L${round(last.x)} ${round(baseline)} L${round(first.x)} ${round(baseline)} Z`;
}

/** Bar width as a fraction of each slot (0–1). */
export function barRects(values: number[], box: ChartBox, max: number, fill = 0.66) {
  const innerWidth = box.width - box.left - box.right;
  const innerHeight = box.height - box.top - box.bottom;
  const slot = values.length ? innerWidth / values.length : innerWidth;
  return values.map((value, index) => {
    const height = (Math.max(0, value) / max) * innerHeight;
    return {
      x: round(box.left + index * slot + (slot * (1 - fill)) / 2),
      y: round(box.top + innerHeight - height),
      width: round(slot * fill),
      height: round(height),
      value,
    };
  });
}
