import { asOptionalNumber, asOptionalString, asRecord, asString } from "./parse";

/**
 * Skill Control's own updates (GitHub Releases), through the desktop bridge
 * window.skillManagerDesktop.appUpdate:
 * - status(): current state, no network. check(): network check (single-flight, cached 60 s).
 * - download() / install(): resolve with the resulting state; they never reject.
 * - onProgress(cb): pushes the FULL state on every change; returns an unsubscribe function.
 * The web and dev builds have no bridge: 关于 then just links to the releases page.
 */

export type AppUpdateStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "offline"
  | "error"
  | "unsupported";

export type UnsupportedReason = "offline" | "development" | "platform" | "portable" | "package" | "location" | null;

export interface AppUpdateState {
  status: AppUpdateStatus;
  current: string | null;
  latest: string | null;
  /** Release notes, markdown (rendered with MarkdownView). */
  notes: string | null;
  /** https release page. */
  url: string | null;
  publishedAt: string | null;
  checkedAt: string | null;
  error: string | null;
  /** False → offer "打开下载页" (url) instead of download / install. */
  canInstall: boolean;
  reason: UnsupportedReason;
  /** One sentence describing the manual path. */
  manual: string | null;
  /** Shown before install (unsigned installer warning on Windows / Linux). */
  notice: string | null;
  /** 0–1 while downloading. */
  progress: number | null;
}

export interface AppUpdateBridge {
  check: () => Promise<unknown>;
  status?: () => Promise<unknown>;
  download?: () => Promise<unknown>;
  install?: () => Promise<unknown>;
  onProgress?: (callback: (state: unknown) => void) => unknown;
}

const REASONS: Exclude<UnsupportedReason, null>[] = ["offline", "development", "platform", "portable", "package", "location"];
const clean = (value: string | null) => (value ? value.replace(/^v/iu, "") : null);

/** Bridge status → ours. "unsupported" with reason "offline" shows as offline. */
export function statusOf(raw: string, reason: UnsupportedReason): AppUpdateStatus {
  const value = raw.toLowerCase();
  if (value === "unsupported") return reason === "offline" ? "offline" : "unsupported";
  if (value === "ready" || value === "downloaded") return "ready";
  if (value === "up-to-date" || value === "available" || value === "downloading" || value === "error" || value === "checking" || value === "installing") return value;
  return "idle";
}

/** 0–1 from percent (0–100), or transferred / total; null when unknown. */
export function progressOf(record: Record<string, unknown>): number | null {
  const percent = asOptionalNumber(record.percent);
  if (percent !== null) return Math.max(0, Math.min(1, percent / 100));
  const transferred = asOptionalNumber(record.transferred);
  const total = asOptionalNumber(record.total);
  return transferred !== null && total ? Math.max(0, Math.min(1, transferred / total)) : null;
}

/** A full bridge state → ours. Missing fields keep `previous` values (e.g. a progress-only push). */
export function normalizeState(raw: unknown, previous: AppUpdateState = INITIAL): AppUpdateState {
  const record = asRecord(raw);
  if (!Object.keys(record).length) return previous;
  const reasonText = asString(record.reason) as Exclude<UnsupportedReason, null>;
  const reason = REASONS.includes(reasonText) ? reasonText : null;
  const status = record.status === undefined ? previous.status : statusOf(asString(record.status), reason);
  const url = asOptionalString(record.url);
  const has = (key: string) => Object.prototype.hasOwnProperty.call(record, key);
  return {
    status,
    current: has("current") ? clean(asOptionalString(record.current)) : previous.current,
    latest: has("latest") ? clean(asOptionalString(record.latest)) : previous.latest,
    notes: has("notes") ? asOptionalString(record.notes)?.slice(0, 20_000) || null : previous.notes,
    url: has("url") ? (url && /^https:\/\//iu.test(url) ? url : null) : previous.url,
    publishedAt: has("publishedAt") ? asOptionalString(record.publishedAt) : previous.publishedAt,
    checkedAt: has("checkedAt") ? asOptionalString(record.checkedAt) : previous.checkedAt,
    error: status === "error" ? asOptionalString(record.error) || previous.error || "检查更新失败。" : null,
    canInstall: has("canInstall") ? record.canInstall === true : previous.canInstall,
    reason: has("reason") || has("status") ? reason : previous.reason,
    manual: has("manual") ? asOptionalString(record.manual) : previous.manual,
    notice: has("notice") ? asOptionalString(record.notice) : previous.notice,
    progress: status === "downloading" ? progressOf(record) ?? previous.progress : status === "ready" ? 1 : null,
  };
}

export function readBridge(): AppUpdateBridge | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as { skillManagerDesktop?: { appUpdate?: Partial<AppUpdateBridge> } }).skillManagerDesktop?.appUpdate;
  return candidate && typeof candidate.check === "function" ? (candidate as AppUpdateBridge) : null;
}

export const INITIAL: AppUpdateState = {
  status: "idle",
  current: null,
  latest: null,
  notes: null,
  url: null,
  publishedAt: null,
  checkedAt: null,
  error: null,
  canInstall: false,
  reason: null,
  manual: null,
  notice: null,
  progress: null,
};

export const STATUS_TEXT: Record<AppUpdateStatus, string> = {
  idle: "还没有检查",
  checking: "正在检查…",
  "up-to-date": "已是最新版本",
  available: "有新版本",
  downloading: "正在下载…",
  ready: "已下载，重启后完成更新",
  installing: "正在安装，马上重启…",
  offline: "离线模式，不检查更新",
  error: "检查更新失败",
  unsupported: "这个版本不能在应用里更新",
};

export const REASON_TEXT: Record<Exclude<UnsupportedReason, null>, string> = {
  offline: "离线模式下不检查更新。",
  development: "开发版本不检查更新。",
  platform: "这个系统暂时不支持在应用里更新。",
  portable: "便携版不能在应用里更新，请下载新版替换。",
  package: "这个安装方式不能在应用里更新。",
  location: "应用所在位置不能写入，请下载新版后手动替换。",
};

/** True when the sidebar should show its quiet "有新版本" line. */
export const hasNews = (state: AppUpdateState) => state.status === "available" || state.status === "ready";

type Listener = () => void;

/** One shared state for 关于 and the sidebar; the main process does the real work. */
export function createAppUpdateStore(getBridge: () => AppUpdateBridge | null = readBridge) {
  let state: AppUpdateState = INITIAL;
  const listeners = new Set<Listener>();
  let started = false;
  let unsubscribe: (() => void) | null = null;
  const set = (next: AppUpdateState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  const apply = (raw: unknown) => set(normalizeState(raw, state));
  const failure = (error: unknown, fallback: string) =>
    set({ ...state, status: "error", progress: null, error: error instanceof Error && error.message ? error.message : fallback });
  return {
    get: () => state,
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    available: () => Boolean(getBridge()),
    /** Once at app start: listen to pushes and read the state without touching the network. */
    async start(): Promise<void> {
      if (started) return;
      const bridge = getBridge();
      if (!bridge) return;
      started = true;
      if (typeof bridge.onProgress === "function") {
        const result = bridge.onProgress((raw) => apply(raw));
        unsubscribe = typeof result === "function" ? (result as () => void) : null;
      }
      if (typeof bridge.status === "function") {
        try {
          apply(await bridge.status());
        } catch {
          // A status read is a convenience; the next push or check fills it in.
        }
      }
    },
    async check(): Promise<void> {
      const bridge = getBridge();
      if (!bridge) {
        set({ ...state, status: "unsupported" });
        return;
      }
      if (state.status === "downloading" || state.status === "installing") return;
      set({ ...state, status: "checking", error: null });
      try {
        apply(await bridge.check());
      } catch (error) {
        failure(error, "检查更新失败。");
      }
    },
    async download(): Promise<void> {
      const bridge = getBridge();
      if (!bridge?.download) return;
      set({ ...state, status: "downloading", progress: 0, error: null });
      try {
        apply(await bridge.download());
      } catch (error) {
        failure(error, "下载失败。");
      }
    },
    /** On success the app quits and relaunches; a failure comes back as an error state. */
    async install(): Promise<void> {
      const bridge = getBridge();
      if (!bridge?.install) return;
      set({ ...state, status: "installing", error: null });
      try {
        const result = asRecord(await bridge.install());
        if (Object.keys(result).length) apply(result);
      } catch (error) {
        failure(error, "安装失败，当前版本没有改动。");
      }
    },
    /** Test hook. */
    reset() {
      unsubscribe?.();
      unsubscribe = null;
      started = false;
      state = INITIAL;
    },
  };
}

export const appUpdateStore = createAppUpdateStore();
