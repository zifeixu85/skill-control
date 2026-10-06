"use client";

import { useEffect, useState } from "react";
import { usePersistent } from "../hooks/usePersistent";
import { readSession, writeSession } from "../lib/storage";
import { DrawerHost } from "./drawers/DrawerHost";
import { AgentPage } from "./pages/agent/AgentPage";
import { ConnectorsPage } from "./pages/ConnectorsPage";
import { ExpertsPage } from "./pages/ExpertsPage";
import { HealthPage } from "./pages/HealthPage";
import { HomePage } from "./pages/HomePage";
import { LibraryPage } from "./pages/library/LibraryPage";
import { PluginsPage } from "./pages/PluginsPage";
import { SettingsPage, themeStore } from "./pages/SettingsPage";
import { SkillsPage } from "./pages/skills/SkillsPage";
import { UpdatesPage } from "./pages/updates/UpdatesPage";
import { UsagePage } from "./pages/usage/UsagePage";
import { PricingPage } from "./pages/pricing/PricingPage";
import { DataProvider, useData } from "./providers/DataProvider";
import { NavProvider, useNav } from "./providers/NavProvider";
import { ToastProvider } from "./providers/ToastProvider";
import { OnboardingSheet } from "./shell/OnboardingSheet";
import { Sidebar } from "./shell/Sidebar";
import { ErrorBoundary } from "./shell/ErrorBoundary";
import { ServiceGate } from "./shell/ServiceGate";

function focusSearchSoon() {
  // The skills page mounts after the navigation renders; poll briefly for its input.
  let tries = 0;
  const attempt = () => {
    const input = document.getElementById("skill-search");
    if (input instanceof HTMLInputElement) {
      input.focus();
      input.select();
    } else if (tries++ < 20) {
      window.setTimeout(attempt, 16);
    }
  };
  attempt();
}

function CurrentPage() {
  const { route } = useNav();
  switch (route.page) {
    case "skills":
      return <SkillsPage />;
    case "library":
      return <LibraryPage />;
    case "plugins":
      return <PluginsPage />;
    case "experts":
      return <ExpertsPage />;
    case "connectors":
      return <ConnectorsPage />;
    case "updates":
      return <UpdatesPage />;
    case "usage":
      return <UsagePage />;
    case "pricing":
      return <PricingPage />;
    case "health":
      return <HealthPage />;
    case "settings":
      return <SettingsPage />;
    case "agent":
      return route.agentId ? <AgentPage key={route.agentId} agentId={route.agentId} /> : <HomePage />;
    default:
      return <HomePage />;
  }
}

function Shell() {
  const { route, go, drawer } = useNav();
  const { needsOnboarding, scan } = useData();
  const [theme] = usePersistent(themeStore);
  const [dismissed, setDismissed] = useState(() =>
    typeof window === "undefined" ? false : readSession("onboarding-dismissed") === "1",
  );

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "light" || theme === "dark") root.dataset.theme = theme;
    else delete root.dataset.theme;
  }, [theme]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        go("skills");
        focusSearchSoon();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [go]);

  const showOnboarding = needsOnboarding && !dismissed && Boolean(scan.data);
  const pageKey = route.page === "agent" ? `agent:${route.agentId}` : route.page;
  const drawerKey = drawer ? `${drawer.kind}:${drawer.id}` : "none";
  return (
    <div className="app-shell" data-page={route.page}>
      <Sidebar />
      <main className="main" id="main" aria-busy={!scan.data}>
        <ServiceGate>
          <ErrorBoundary key={pageKey}>
            <CurrentPage key={pageKey} />
          </ErrorBoundary>
        </ServiceGate>
        <ErrorBoundary quiet key={drawerKey}>
          <DrawerHost />
        </ErrorBoundary>
      </main>
      {showOnboarding ? (
        <OnboardingSheet
          onDismiss={() => {
            writeSession("onboarding-dismissed", "1");
            setDismissed(true);
          }}
        />
      ) : null}
    </div>
  );
}

export function App() {
  return (
    <ToastProvider>
      <NavProvider>
        <DataProvider>
          <Shell />
        </DataProvider>
      </NavProvider>
    </ToastProvider>
  );
}
