"use client";

import { isUnsupported, useResource } from "../../../hooks/useResource";
import { api } from "../../../lib/api";
import type { SkillView } from "../../../lib/skill-model";
import { unitForPaths } from "../../../lib/updates";
import { useNav } from "../../providers/NavProvider";
import { StatusTag, VersionLine } from "../updates/UnitRow";

/** Where the skill comes from and whether its source has something newer. */
export function SkillSource({ view }: { view: SkillView }) {
  const updates = useResource("updates", () => api.updates());
  const { openDrawer } = useNav();
  if (!updates.data || isUnsupported(updates.error)) return null;
  const unit = unitForPaths(updates.data.units, view.skill.instances.map((instance) => instance.path));
  if (!unit) return null;
  const attention = unit.status === "update-available" || unit.status === "conflict";
  return (
    <section>
      <h3>来源与更新</h3>
      <div className={`source-box ${attention ? "attention" : ""}`}>
        <div>
          <span className="source-label">{unit.sourceLabel || unit.sourceType}</span>
          <StatusTag unit={unit} />
          <VersionLine unit={unit} />
        </div>
        <button type="button" className={`btn sm ${attention ? "primary" : ""}`} onClick={() => openDrawer({ kind: "update", id: unit.unitKey })}>
          {attention ? "有新版本，去看看" : "查看来源"}
        </button>
      </div>
    </section>
  );
}
