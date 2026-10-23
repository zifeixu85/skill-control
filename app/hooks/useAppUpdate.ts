"use client";

import { useSyncExternalStore } from "react";
import { appUpdateStore, INITIAL, type AppUpdateState } from "../lib/app-update";

/** Shared app-update state (关于 and the sidebar hint read the same store). */
export function useAppUpdate(): AppUpdateState {
  return useSyncExternalStore(appUpdateStore.subscribe, appUpdateStore.get, () => INITIAL);
}
