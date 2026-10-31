"use client";

import { useState, type ReactNode } from "react";
import { usePolling } from "../../hooks/usePolling";
import { ApiError, errorMessage } from "../../lib/api";
import { RefreshIcon } from "../icons";
import { useData } from "../providers/DataProvider";
import { EmptyState } from "../ui/basics";

/** How long a refused connection counts as "still starting" before it is shown as an error. */
const STARTUP_GRACE_MS = 30_000;
const loadedAt = typeof performance === "undefined" ? 0 : performance.timeOrigin;

/** No answer at all (connection refused): the local service is probably still starting. */
export const isStarting = (error: Error | null) => error instanceof ApiError && error.status === 0 && !error.timedOut;

/**
 * When the very first scan fails there is nothing useful to show. While the local service is
 * still starting (connection refused, first 30 s) say so and retry quietly; after that, or for
 * any other error, explain and offer a retry.
 */
export function ServiceGate({ children }: { children: ReactNode }) {
  const { scan, refresh } = useData();
  const [gaveUp, setGaveUp] = useState(false);
  const failed = scan.status === "error" && !scan.data;
  const starting = failed && isStarting(scan.error) && !gaveUp;
  usePolling(
    starting,
    () => {
      if (Date.now() - loadedAt > STARTUP_GRACE_MS) setGaveUp(true);
      else void refresh();
    },
    1_500,
  );
  if (starting) {
    return (
      <div className="gate">
        <EmptyState tone="pending" title="正在启动本地服务…">
          第一次打开可能要几秒钟，准备好后会自动显示。
        </EmptyState>
      </div>
    );
  }
  if (failed) {
    return (
      <div className="gate">
        <EmptyState
          tone="error"
          title="读不到本机的技能"
          action={
            <button
              type="button"
              className="btn"
              onClick={() => {
                setGaveUp(false);
                void refresh();
              }}
            >
              <RefreshIcon />
              再试一次
            </button>
          }
        >
          {errorMessage(scan.error, "本地服务暂时不可用。")}
        </EmptyState>
      </div>
    );
  }
  return <>{children}</>;
}
