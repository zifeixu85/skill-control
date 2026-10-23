"use client";

import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { takeSectionTarget } from "../../providers/NavProvider";

export const SETTINGS_SECTIONS = [
  { id: "agents", label: "常用 Agent" },
  { id: "mode", label: "安装方式" },
  { id: "theme", label: "外观" },
  { id: "privacy", label: "数据与隐私" },
  { id: "versions", label: "版本检查" },
  { id: "about", label: "关于" },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]["id"];

const isSection = (value: string | null): value is SettingsSection => SETTINGS_SECTIONS.some((section) => section.id === value);

function groupOf(id: SettingsSection): HTMLElement | null {
  return document.getElementById(`set-group-${id}`);
}

/** Scroll a group to the top of the page's own scroll area (never the window). */
function scrollToGroup(id: SettingsSection, smooth: boolean) {
  const group = groupOf(id);
  const scroll = group?.closest<HTMLElement>(".scroll");
  if (!group || !scroll) return;
  const top = group.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - 8;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  scroll.scrollTo({ top, behavior: smooth && !reduce ? "smooth" : "auto" });
}

/** Which group is at the top of the scroll area; clicks jump there; deep links (go("settings", { section })) too. */
export function useSectionSpy(ready: boolean) {
  const [current, setCurrent] = useState<SettingsSection>("agents");
  const lock = useRef<{ id: SettingsSection; until: number } | null>(null);
  const showSection = useCallback((id: SettingsSection) => {
    setCurrent(id);
    // Keep the clicked item highlighted while the smooth scroll runs.
    lock.current = { id, until: Date.now() + 900 };
    scrollToGroup(id, true);
  }, []);
  const arrive = useEffectEvent((target: string | null) => {
    if (!isSection(target)) return;
    window.requestAnimationFrame(() => {
      setCurrent(target);
      lock.current = { id: target, until: Date.now() + 600 };
      scrollToGroup(target, false);
    });
  });

  useEffect(() => {
    if (!ready) return undefined;
    arrive(takeSectionTarget());
    const onSection = (event: Event) => arrive((event as CustomEvent<string>).detail);
    window.addEventListener("skill-control:section", onSection);
    return () => window.removeEventListener("skill-control:section", onSection);
  }, [ready]);

  useEffect(() => {
    if (!ready) return undefined;
    const scroll = groupOf("agents")?.closest<HTMLElement>(".scroll");
    if (!scroll) return undefined;
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (lock.current && Date.now() < lock.current.until) return;
      lock.current = null;
      const area = scroll.getBoundingClientRect();
      const line = area.top + Math.min(160, area.height * 0.35);
      const atBottom = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 4;
      let next: SettingsSection = "agents";
      for (const section of SETTINGS_SECTIONS) {
        const top = groupOf(section.id)?.getBoundingClientRect().top;
        if (top === undefined) continue;
        // At the very bottom, the last group that is on screen wins (it may never reach the line).
        if (top <= line || (atBottom && top < area.bottom - 40)) next = section.id;
      }
      setCurrent(next);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    scroll.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroll.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [ready]);

  return { current, showSection };
}

/** 设置's left column: anchors with the current section highlighted. A row of chips when narrow. */
export function SettingsNav({ current, onPick }: { current: SettingsSection; onPick: (id: SettingsSection) => void }) {
  return (
    <nav className="set-nav" aria-label="设置分区">
      {SETTINGS_SECTIONS.map((section) => (
        <button
          key={section.id}
          type="button"
          className={current === section.id ? "on" : ""}
          aria-current={current === section.id ? "location" : undefined}
          onClick={() => onPick(section.id)}
        >
          {section.label}
        </button>
      ))}
    </nav>
  );
}
