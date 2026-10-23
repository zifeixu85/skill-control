import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./helpers/load-ts.mjs";

const sort = await loadTs("app/lib/sort.ts");

const items = [
  { name: "beta", uses: 3, lastUsedAt: "2026-10-20T00:00:00Z", installedAt: "2026-01-01T00:00:00Z" },
  { name: "alpha", uses: 0, lastUsedAt: null, installedAt: "2026-09-01T00:00:00Z" },
  { name: "gamma", uses: 9, lastUsedAt: "2026-10-01T00:00:00Z", installedAt: null },
  { name: "Delta", uses: 3, lastUsedAt: "bad date", installedAt: "2026-05-01T00:00:00Z" },
];
const fields = (item) => item;
const names = (list) => list.map((item) => item.name);

test("sort: each key orders by its value, missing values last, ties by name", () => {
  assert.deepEqual(names(sort.sortItems(items, "uses", fields)), ["gamma", "beta", "Delta", "alpha"]);
  assert.deepEqual(names(sort.sortItems(items, "used", fields)), ["beta", "gamma", "alpha", "Delta"]);
  assert.deepEqual(names(sort.sortItems(items, "installed", fields)), ["alpha", "Delta", "beta", "gamma"]);
  assert.deepEqual(names(sort.sortItems(items, "name", fields)), ["alpha", "beta", "Delta", "gamma"]);
  const copy = [...items];
  sort.sortItems(items, "uses", fields);
  assert.deepEqual(items, copy, "never mutates the input");
});

test("sort: options only offer keys some item has; the default follows the data", () => {
  assert.deepEqual(sort.sortOptions(items, fields), ["uses", "used", "installed", "name"]);
  assert.deepEqual(sort.sortOptions(items, fields, ["installed", "name"]), ["installed", "name"]);
  const bare = [{ name: "x" }, { name: "y", uses: 0 }];
  assert.deepEqual(sort.sortOptions(bare, fields), ["name"]);
  assert.equal(sort.resolveSort("", ["uses", "name"]), "uses", "最常用 when there is usage");
  assert.equal(sort.resolveSort("", ["installed", "name"]), "name", "名称 otherwise");
  assert.equal(sort.resolveSort("installed", ["installed", "name"]), "installed", "a remembered choice wins");
  assert.equal(sort.resolveSort("used", ["installed", "name"]), "name", "a choice that's no longer offered falls back");
  assert.equal(sort.SORT_LABELS.updated, "最近更新");
});

test("sort: each list remembers its own choice in localStorage", async () => {
  const data = new Map();
  globalThis.window = { localStorage: { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) } };
  try {
    const fresh = await loadTs("app/lib/sort.ts");
    fresh.sortStore("skills").set("installed");
    fresh.sortStore("plugins").set("name");
    assert.equal(data.get("skill-control:sort:skills"), "installed");
    assert.equal(data.get("skill-control:sort:plugins"), "name");
    assert.equal(fresh.sortStore("skills"), fresh.sortStore("skills"), "one store per list");
    data.set("skill-control:sort:mcp", "drop table");
    assert.equal((await loadTs("app/lib/sort.ts")).sortStore("mcp").get(), "", "invalid stored values are ignored");
  } finally {
    delete globalThis.window;
  }
});
