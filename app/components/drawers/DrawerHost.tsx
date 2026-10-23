"use client";

import { useNav } from "../providers/NavProvider";
import { ExpertDrawer } from "./ExpertDrawer";
import { McpDrawer } from "./McpDrawer";
import { PluginDrawer } from "./PluginDrawer";
import { ImportDialog } from "./ImportDialog";
import { PlanReview } from "../pages/library/PlanReview";
import { RestoreDialog } from "./RestoreDialog";
import { UpdateDrawer } from "./UpdateDrawer";
import { ConnectorDrawer } from "./ConnectorDrawer";
import { CliDrawer } from "./CliDrawer";
import { DiscoveryDrawer } from "./DiscoveryDrawer";

/** Drawers and dialogs that any page can open. Keyed by target so a new item starts fresh. */
export function DrawerHost() {
  const { drawer, closeDrawer, importOpen, setImportOpen, restoreHistoryId, setRestoreHistoryId, libraryRequest, setLibraryRequest } =
    useNav();
  return (
    <>
      {drawer?.kind === "plugin" ? <PluginDrawer key={drawer.id} pluginKey={drawer.id} onClose={closeDrawer} /> : null}
      {drawer?.kind === "expert" ? <ExpertDrawer key={drawer.id} capabilityId={drawer.id} onClose={closeDrawer} /> : null}
      {drawer?.kind === "mcp" ? <McpDrawer key={drawer.id} name={drawer.id} onClose={closeDrawer} /> : null}
      {drawer?.kind === "update" ? <UpdateDrawer key={drawer.id} unitKey={drawer.id} onClose={closeDrawer} /> : null}
      {drawer?.kind === "connector" ? <ConnectorDrawer key={drawer.id} id={drawer.id} onClose={closeDrawer} /> : null}
      {drawer?.kind === "cli" ? <CliDrawer key={drawer.id} id={drawer.id} onClose={closeDrawer} /> : null}
      {drawer?.kind === "discovery" ? <DiscoveryDrawer onClose={closeDrawer} /> : null}
      {importOpen ? <ImportDialog onClose={() => setImportOpen(false)} /> : null}
      {libraryRequest ? (
        <PlanReview
          key={JSON.stringify(libraryRequest)}
          request={libraryRequest}
          onClose={() => setLibraryRequest(null)}
          onWiden={() => setLibraryRequest({ action: "batch", title: "一键整理技能库" })}
        />
      ) : null}
      {restoreHistoryId ? (
        <RestoreDialog key={restoreHistoryId} historyId={restoreHistoryId} onClose={() => setRestoreHistoryId(null)} />
      ) : null}
    </>
  );
}
