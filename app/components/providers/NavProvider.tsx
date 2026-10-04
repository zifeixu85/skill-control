"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { usePersistent } from "../../hooks/usePersistent";
import {
  isValidRoute,
  parseRoute,
  serializeRoute,
  type DrawerTarget,
  type PageId,
  type Route,
} from "../../lib/navigation";
import { persistentStore } from "../../lib/storage";

const routeStore = persistentStore<string>("route", "home", isValidRoute);
const filterStore = persistentStore<string>("skills-filter", "all", (value) => value.length < 80);

export interface GoOptions {
  agentId?: string;
  filter?: string;
  skillId?: string | null;
}

export interface Nav {
  route: Route;
  go: (page: PageId, options?: GoOptions) => void;
  drawer: DrawerTarget | null;
  openDrawer: (target: DrawerTarget) => void;
  closeDrawer: () => void;
  skillFilter: string;
  setSkillFilter: (filter: string) => void;
  selectedSkillId: string | null;
  selectSkill: (id: string | null) => void;
  query: string;
  setQuery: (query: string) => void;
  importOpen: boolean;
  setImportOpen: (open: boolean) => void;
}

const NavContext = createContext<Nav | null>(null);

export function NavProvider({ children }: { children: ReactNode }) {
  const [routeText, setRouteText] = usePersistent(routeStore);
  const [skillFilter, setSkillFilter] = usePersistent(filterStore);
  const [drawer, setDrawer] = useState<DrawerTarget | null>(null);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [importOpen, setImportOpen] = useState(false);

  const go = useCallback(
    (page: PageId, options: GoOptions = {}) => {
      setRouteText(serializeRoute({ page, agentId: page === "agent" ? options.agentId || null : null }));
      setDrawer(null);
      if (options.filter !== undefined) setSkillFilter(options.filter);
      if (options.skillId !== undefined) setSelectedSkillId(options.skillId);
    },
    [setRouteText, setSkillFilter],
  );

  const value = useMemo<Nav>(
    () => ({
      route: parseRoute(routeText),
      go,
      drawer,
      openDrawer: setDrawer,
      closeDrawer: () => setDrawer(null),
      skillFilter,
      setSkillFilter,
      selectedSkillId,
      selectSkill: setSelectedSkillId,
      query,
      setQuery,
      importOpen,
      setImportOpen,
    }),
    [routeText, go, drawer, skillFilter, setSkillFilter, selectedSkillId, query, importOpen],
  );

  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

export function useNav(): Nav {
  const value = useContext(NavContext);
  if (!value) throw new Error("useNav must be used inside NavProvider");
  return value;
}
