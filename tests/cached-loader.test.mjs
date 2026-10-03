import assert from "node:assert/strict";
import test from "node:test";
import { createCachedLoader } from "../server/cached-loader.mjs";

test("shares one in-flight load, honours the TTL and debounces forced reloads", async () => {
  let clock = 0;
  let loads = 0;
  let release;
  const loader = createCachedLoader(
    () => {
      loads += 1;
      return new Promise((resolve) => {
        release = () => resolve(`value-${loads}`);
      });
    },
    { ttlMs: 60_000, forceDebounceMs: 5_000, now: () => clock },
  );
  assert.equal(await loader.peek(), null);
  const first = loader.get();
  const second = loader.get(true);
  release();
  assert.deepEqual(await Promise.all([first, second]), ["value-1", "value-1"]);
  assert.equal(loads, 1);

  clock = 4_000;
  assert.equal(await loader.get(true), "value-1");
  assert.equal(loads, 1);

  clock = 6_000;
  const forced = loader.get(true);
  release();
  assert.equal(await forced, "value-2");

  clock = 30_000;
  assert.equal(await loader.get(), "value-2");
  clock = 70_000;
  const expired = loader.get();
  assert.equal(await loader.peek(), "value-2");
  release();
  assert.equal(await expired, "value-3");
});

test("does not cache failures", async () => {
  let attempts = 0;
  const loader = createCachedLoader(
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("boom");
      return "ok";
    },
    { ttlMs: 60_000 },
  );
  await assert.rejects(loader.get(), /boom/);
  assert.equal(await loader.get(), "ok");
});

test("clear() discards cached values and results of loads started before it", async () => {
  let loads = 0;
  let release;
  const loader = createCachedLoader(
    () => {
      loads += 1;
      const current = loads;
      return new Promise((resolve) => {
        release = () => resolve(`value-${current}`);
      });
    },
    { ttlMs: 60_000 },
  );
  const stale = loader.get();
  loader.clear();
  release();
  assert.equal(await stale, "value-1");
  const fresh = loader.get();
  release();
  assert.equal(await fresh, "value-2");
  assert.equal(await loader.get(), "value-2");
  const syncThrow = createCachedLoader(() => {
    throw new Error("sync");
  }, { ttlMs: 1 });
  await assert.rejects(syncThrow.get(), /sync/);
});
