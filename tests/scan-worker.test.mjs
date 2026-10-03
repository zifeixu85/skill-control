import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runScanWorker } from "../server/local-server.mjs";
import { writeFixtureFile } from "./fixtures/smartorder.mjs";

async function fixture(context) {
  const home = await mkdtemp(path.join(tmpdir(), "scan-worker-test-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, "skills");
  await writeFixtureFile(root, "demo/SKILL.md", "---\nname: demo\ndescription: demo\n---\n# Demo\n");
  const config = {
    agents: [{ id: "codex", name: "Codex", shortName: "CX", color: "#8fc9ef", paths: [root] }],
    visibleAgentIds: ["codex"],
  };
  return { home, config };
}

test("scans on a worker thread against an isolated home directory", async (context) => {
  const { home, config } = await fixture(context);
  const scan = await runScanWorker({ config, persistentCache: false, homeDirectory: home });
  assert.deepEqual(scan.skills.map((skill) => skill.name), ["demo"]);
});

test("terminates a scan that exceeds the watchdog and rejects with a friendly error", async (context) => {
  const { home, config } = await fixture(context);
  await assert.rejects(
    runScanWorker({ config, persistentCache: false, homeDirectory: home, timeoutMs: 1 }),
    (error) => error.code === "SCAN_TIMEOUT" && /已停止/.test(error.message),
  );
  const retry = await runScanWorker({ config, persistentCache: false, homeDirectory: home });
  assert.equal(retry.skills.length, 1);
});
