"use client";

import type { ReactNode } from "react";
import { errorMessage } from "../../lib/api";
import { RefreshIcon } from "../icons";
import { useData } from "../providers/DataProvider";
import { EmptyState } from "../ui/basics";

/** When the very first scan fails there is nothing useful to show; explain and offer a retry. */
export function ServiceGate({ children }: { children: ReactNode }) {
  const { scan, refresh } = useData();
  if (scan.status === "error" && !scan.data) {
    return (
      <div className="gate">
        <EmptyState
          tone="error"
          title="读不到本机的技能"
          action={
            <button type="button" className="btn" onClick={() => void refresh()}>
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
