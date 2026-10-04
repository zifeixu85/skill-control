import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./helpers/load-ts.mjs";

const resizer = await loadTs("app/components/pages/skills/InspectorResizer.tsx");
const plugins = await loadTs("app/lib/plugins.ts");

test("inspector width is clamped and always leaves room for the list", () => {
  assert.equal(resizer.clampInspector(Number.NaN), resizer.INSPECTOR_DEFAULT);
  assert.equal(resizer.clampInspector(100), resizer.INSPECTOR_MIN);
  assert.equal(resizer.clampInspector(5000), resizer.INSPECTOR_MAX);
  assert.equal(resizer.clampInspector(700, 1000), 500, "list keeps 500 px");
  assert.equal(resizer.clampInspector(700, 600), resizer.INSPECTOR_MIN);
});

test("plugin components tolerate missing lists and match connectors by id", () => {
  const plugin = { id: "github@openai", name: "github", components: { apps: [{ key: "github", connectorId: "c1" }] } };
  const components = plugins.componentsOf(plugin);
  assert.deepEqual(components.skills, []);
  assert.equal(components.hooks, false);
  const matched = plugins.pluginConnectors(plugin, [
    { id: "c1", providedByPlugins: [] },
    { id: "c2", providedByPlugins: ["github@openai"] },
    { id: "c3", providedByPlugins: ["other@x"] },
  ]);
  assert.deepEqual(matched.map((connector) => connector.id), ["c1", "c2"]);
  assert.deepEqual(plugins.componentsOf({ components: null }).apps, []);
});
