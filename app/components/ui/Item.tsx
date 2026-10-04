"use client";

import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { arrangeChips, fitCount, type ChipSpec } from "../../lib/chips";

/**
 * The main column of every list row and card: title (one line), a secondary identifier
 * (slug, source, version) on its own line, then the description clamped to 1 or 2 lines.
 */
export function ItemText({
  title,
  titleText,
  meta,
  desc,
  lines = 1,
  mono = false,
}: {
  title: ReactNode;
  /** Tooltip for a truncated title when `title` isn't plain text. */
  titleText?: string;
  meta?: ReactNode;
  desc?: ReactNode;
  lines?: 1 | 2;
  /** Show `meta` as code (slugs, paths). */
  mono?: boolean;
}) {
  return (
    <div className="it-main">
      <div className="it-title" title={titleText ?? (typeof title === "string" ? title : undefined)}>
        {title}
      </div>
      {meta ? <div className={`it-meta ${mono ? "mono" : ""}`}>{meta}</div> : null}
      {desc ? <div className={`it-desc l${lines}`}>{desc}</div> : null}
    </div>
  );
}

function Chip({ chip }: { chip: ChipSpec }) {
  const tone = chip.tone && chip.tone !== "ok" ? chip.tone : chip.kind === "status" ? "" : "mute";
  return (
    <span className={`tag ${tone} chip-${chip.kind}`} title={chip.title || chip.text} data-chip="">
      {chip.count ? (
        <>
          {chip.count.before}
          <b className="chip-num">{chip.count.value}</b>
          {chip.count.after}
        </>
      ) : (
        chip.text
      )}
    </span>
  );
}

const MORE_WIDTH = 34;

function FittedChips({ chips, max, className }: { chips: ChipSpec[]; max: number; className: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const widths = useRef<number[] | null>(null);
  const [fit, setFit] = useState<number | null>(null);
  const maxShown = useEffectEvent(() => max);
  useEffect(() => {
    const row = ref.current;
    if (!row) return undefined;
    // Measured once with every chip shown; resizes reuse the widths.
    const observer = new ResizeObserver(() => {
      if (!widths.current) widths.current = [...row.querySelectorAll<HTMLElement>("[data-chip]")].map((chip) => chip.offsetWidth);
      const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 5;
      setFit(fitCount(widths.current, row.clientWidth, gap, MORE_WIDTH, maxShown()));
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, []);
  // Every chip renders once so it can be measured.
  const limit = fit ?? chips.length;
  const shown = chips.slice(0, limit);
  const hidden = chips.slice(limit);
  return (
    <div className={`chip-row ${className}`} ref={ref}>
      {shown.map((chip) => (
        <Chip key={chip.id} chip={chip} />
      ))}
      {hidden.length ? (
        <span className="tag mute chip-more" title={hidden.map((chip) => chip.text).join("\n")} aria-label={`另有：${hidden.map((chip) => chip.text).join("、")}`}>
          +{hidden.length}
        </span>
      ) : null}
    </div>
  );
}

/** One line of chips in the shared order; what doesn't fit folds into "+N" with a tooltip. */
export function ChipRow({ chips, max = 6, className = "" }: { chips: ChipSpec[]; max?: number; className?: string }) {
  if (!chips.length) return null;
  const { shown } = arrangeChips(chips, chips.length);
  // New chips remount, so they are measured again.
  const signature = shown.map((chip) => `${chip.id}:${chip.text}`).join("|");
  return <FittedChips key={signature} chips={shown} max={max} className={className} />;
}

/** A stacked tag column for tables: each tag on its own line, aligned across rows. */
export function TagStack({ chips }: { chips: ChipSpec[] }) {
  if (!chips.length) return null;
  const { shown } = arrangeChips(chips, chips.length);
  return (
    <div className="tag-stack">
      {shown.map((chip) => (
        <Chip key={chip.id} chip={chip} />
      ))}
    </div>
  );
}
