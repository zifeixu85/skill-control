"use client";

import { useNav } from "../providers/NavProvider";
import { ExpertDrawer } from "./ExpertDrawer";
import { McpDrawer } from "./McpDrawer";
import { PluginDrawer } from "./PluginDrawer";
import { ImportDialog } from "./ImportDialog";
import { RestoreDialog } from "./RestoreDialog";
import { UpdateDrawer } from "./UpdateDrawer";

/** Drawers and dialogs that any page can open. Keyed by target so a new item starts fresh. */
export function DrawerHost() {
  const { drawer, closeDrawer, importOpen, setImportOpen, restoreHistoryId, setRestoreHistoryId } = useNav();
  return (
    <>
      {drawer?.kind === "plugin" ? <PluginDrawer key={drawer.id} pluginKey={drawer.id} onClose={closeDrawer} /> : null}
      {drawer?.kind === "expert" ? <ExpertDrawer key={drawer.id} capabilityId={drawer.id} onClose={closeDrawer} /> : null}
      {drawer?.kind === "mcp" ? <McpDrawer key={drawer.id} name={drawer.id} onClose={closeDrawer} /> : null}
      {drawer?.kind === "update" ? <UpdateDrawer key={drawer.id} unitKey={drawer.id} onClose={closeDrawer} /> : null}
      {importOpen ? <ImportDialog onClose={() => setImportOpen(false)} /> : null}
      {restoreHistoryId ? (
        <RestoreDialog key={restoreHistoryId} historyId={restoreHistoryId} onClose={() => setRestoreHistoryId(null)} />
      ) : null}
    </>
  );
}
