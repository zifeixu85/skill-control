"use client";

import { useEffect, useEffectEvent } from "react";
import { refreshAfterWrite } from "../../../hooks/refresh";
import { usePolling } from "../../../hooks/usePolling";
import { loadResource, useResource } from "../../../hooks/useResource";
import { api } from "../../../lib/api";
import { freshAutoLinkRun } from "../../../lib/library";
import { readStored, writeStored } from "../../../lib/storage";
import { useData } from "../../providers/DataProvider";
import { useToast } from "../../providers/ToastProvider";

const SEEN_KEY = "auto-link-seen";
/** The service links new library skills within seconds; the page learns about it this often. */
const POLL_MS = 30_000;

/**
 * "已把 pdf-tools 接入 Claude Code、WorkBuddy · 撤销" after each 自动接入 batch, once per
 * batch (remembered across restarts), wherever the user is in the app.
 */
export function AutoLinkToasts() {
  const { agentName } = useData();
  const library = useResource("library", () => api.library());
  const toast = useToast();
  const autoLink = library.data?.autoLink || null;
  usePolling(Boolean(autoLink?.enabled), () => void loadResource("library", undefined, true), POLL_MS);

  const at = autoLink?.lastRun?.at || null;
  const announce = useEffectEvent(() => {
    const seen = readStored(SEEN_KEY);
    const fresh = freshAutoLinkRun(autoLink, seen, Date.now(), agentName);
    const newer = at && (!seen || !(Date.parse(at) <= Date.parse(seen)));
    if (newer) writeStored(SEEN_KEY, at);
    if (!fresh) return;
    const historyId = fresh.historyId;
    // 撤销 undoes the whole run at once; the service then won't connect those pairs again.
    toast.show(fresh.message, {
      action: historyId
        ? {
            label: "撤销",
            run: async () => {
              try {
                await api.restoreAutoLink(historyId);
                toast.show("已撤销这次自动接入，以后不会再自动接回");
              } finally {
                refreshAfterWrite();
              }
            },
          }
        : undefined,
    });
  });
  useEffect(() => {
    if (at) announce();
  }, [at]);
  return null;
}
