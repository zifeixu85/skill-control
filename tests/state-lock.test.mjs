import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LOCK_FILE, withStateLock } from "../server/state-lock.mjs";

const LOCK_MODULE = fileURLToPath(new URL("../server/state-lock.mjs", import.meta.url));

async function tempState(context) {
  const directory = await mkdtemp(path.join(tmpdir(), "state-lock-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** Another process that takes the lock, says so, and holds it for `holdMs`. */
function holder(stateDirectory, holdMs) {
  const code = `import(${JSON.stringify(LOCK_MODULE)}).then(({ withStateLock }) => withStateLock(${JSON.stringify(stateDirectory)}, async () => { console.log("held"); await new Promise((r) => setTimeout(r, ${holdMs})); }, { label: "other process" }))`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  const held = new Promise((resolve) => child.stdout.on("data", (chunk) => String(chunk).includes("held") && resolve()));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  return { held, exited };
}

test("the lock is exclusive across processes: a second writer waits, or gives up with code 'locked'", { timeout: 30_000 }, async (context) => {
  const stateDirectory = await tempState(context);
  const other = holder(stateDirectory, 1_500);
  await other.held;
  const owner = JSON.parse(await readFile(path.join(stateDirectory, LOCK_FILE), "utf8"));
  assert.equal(owner.label, "other process");
  await assert.rejects(withStateLock(stateDirectory, async () => "never", { timeoutMs: 200 }), (error) => error.code === "locked" && /other process/u.test(error.message));
  const started = Date.now();
  assert.equal(await withStateLock(stateDirectory, async () => "mine", { timeoutMs: 10_000 }), "mine");
  assert.ok(Date.now() - started >= 500, "waited for the other process");
  await other.exited;
  assert.equal(await stat(path.join(stateDirectory, LOCK_FILE)).catch(() => null), null, "released");
});

test("a lock left by a process that is gone, or an old one, is taken over", async (context) => {
  const stateDirectory = await tempState(context);
  const file = path.join(stateDirectory, LOCK_FILE);
  await writeFile(file, JSON.stringify({ pid: 2_147_483_000, host: (await import("node:os")).hostname(), at: new Date().toISOString(), token: "dead" }));
  assert.equal(await withStateLock(stateDirectory, async () => 1, { timeoutMs: 2_000 }), 1);
  await writeFile(file, JSON.stringify({ pid: process.pid, host: "elsewhere", at: "2020-01-01T00:00:00.000Z", token: "old" }));
  assert.equal(await withStateLock(stateDirectory, async () => 2, { timeoutMs: 2_000 }), 2);
});

test("nested calls reuse the lock; parallel calls in one process queue", async (context) => {
  const stateDirectory = await tempState(context);
  const order = [];
  const nested = await withStateLock(stateDirectory, () => withStateLock(stateDirectory, async () => "inner"));
  assert.equal(nested, "inner");
  await Promise.all(
    [1, 2, 3].map((index) =>
      withStateLock(stateDirectory, async () => {
        order.push(`start ${index}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push(`end ${index}`);
      }),
    ),
  );
  assert.deepEqual(order, ["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
  // A failing task releases the lock.
  await assert.rejects(withStateLock(stateDirectory, async () => {
    throw new Error("boom");
  }), /boom/u);
  assert.equal(await withStateLock(stateDirectory, async () => "after", { timeoutMs: 500 }), "after");
});
