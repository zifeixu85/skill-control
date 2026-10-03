import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildSyncPlan,
  compareVersions,
  parseFrontmatter,
  sanitizeConfig,
  scanAll,
} from "../server/local-server.mjs";
import { writeFixtureFile } from "./fixtures/smartorder.mjs";
import { writeSessionFile } from "./fixtures/integrations.mjs";

const SYMLINKS = process.platform !== "win32";

async function tempHome(context) {
  const home = await mkdtemp(path.join(tmpdir(), "primary-status-test-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

const manifest = (name, body = "", version = "") =>
  `---\nname: ${name}\ndescription: ${name} fixture\n${version ? `version: ${version}\n` : ""}---\n# ${name}\n${body}\n`;

async function writeSkill(root, directory, content, mtime) {
  const file = await writeFixtureFile(root, `${directory}/SKILL.md`, content);
  if (mtime) await utimes(file, mtime, mtime);
  return path.dirname(file);
}

const agent = (id, paths) => ({ id, name: id, shortName: id.slice(0, 2), color: "#8fc9ef", paths });

test("parses frontmatter versions and compares semver-like versions", () => {
  assert.equal(parseFrontmatter(manifest("a", "", "1.2.3"), "a").version, "1.2.3");
  assert.equal(parseFrontmatter("---\nname: b\nmetadata:\n  version: \"2.0\"\n---\n", "b").version, "2.0");
  assert.equal(parseFrontmatter(manifest("c"), "c").version, "");
  assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
  assert.ok(compareVersions("v2.0.0", "2.0.0-beta.1") > 0);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.ok(compareVersions("0.1.0", "0.2.0") < 0);
  assert.equal(compareVersions("latest", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0", "bd2122cb"), 0);
});

test("stores validated primary agents and keeps them visible", () => {
  const agents = [agent("codex", ["/a"]), agent("claude", ["/b"]), agent("workbuddy", ["/c"])];
  assert.equal(sanitizeConfig({ agents }).primaryAgentIds, null);
  const config = sanitizeConfig({
    agents,
    visibleAgentIds: ["workbuddy"],
    primaryAgentIds: ["claude", "unknown", "claude", 7],
  });
  assert.deepEqual(config.primaryAgentIds, ["claude"]);
  assert.deepEqual(config.visibleAgentIds, ["workbuddy", "claude"]);
  assert.equal(sanitizeConfig({ agents, primaryAgentIds: ["missing"] }).primaryAgentIds, null);
  const many = ["a", "b", "c", "d", "e"].map((id) => agent(id, [`/${id}`]));
  assert.deepEqual(
    sanitizeConfig({ agents: many, primaryAgentIds: ["a", "b", "c", "d", "e"] }).primaryAgentIds,
    ["a", "b", "c", "d"],
  );
});

test("computes primary status, newest version and summary counts", async (context) => {
  const home = await tempHome(context);
  const codexRoot = path.join(home, ".codex", "skills");
  const vendorRoot = path.join(home, ".codex", "vendor_imports", "skills");
  const claudeRoot = path.join(home, ".claude", "skills");
  const workbuddyRoot = path.join(home, ".workbuddy", "skills");
  const agentsRoot = path.join(home, ".agents", "skills");
  const mirasimRoot = path.join(home, ".mirasim", "skills");
  const older = new Date("2026-09-01T00:00:00Z");
  const newer = new Date("2026-09-20T00:00:00Z");

  await writeSkill(codexRoot, "same", manifest("same", "identical"), older);
  await writeSkill(claudeRoot, "same", manifest("same", "identical"), older);
  await writeSkill(codexRoot, "by-version", manifest("by-version", "codex", "1.10.0"), older);
  await writeSkill(claudeRoot, "by-version", manifest("by-version", "claude", "1.9.0"), newer);
  await writeSkill(codexRoot, "by-mtime", manifest("by-mtime", "codex"), older);
  await writeSkill(claudeRoot, "by-mtime", manifest("by-mtime", "claude"), newer);
  await writeSkill(codexRoot, "tie", manifest("tie", "codex"), older);
  await writeSkill(claudeRoot, "tie", manifest("tie", "claude"), older);
  await writeSkill(vendorRoot, "vendor-only-diff", manifest("vendor-only-diff", "vendor"), newer);
  await writeSkill(claudeRoot, "vendor-only-diff", manifest("vendor-only-diff", "claude"), older);
  await writeSkill(codexRoot, "dup", manifest("dup", "local"), older);
  await writeSkill(vendorRoot, "dup", manifest("dup", "vendor"), older);
  await writeSkill(workbuddyRoot, "elsewhere", manifest("elsewhere"), older);
  await writeSkill(codexRoot, "mixed-version", manifest("mixed-version", "codex", "9.0.0"), older);
  await writeSkill(claudeRoot, "mixed-version", manifest("mixed-version", "claude"), newer);
  await writeSkill(codexRoot, "dup-same", manifest("dup-same", "same"), older);
  await writeSkill(agentsRoot, "dup-same", manifest("dup-same", "same"), older);
  await writeSkill(codexRoot, "dup-diff", manifest("dup-diff", "one"), older);
  await writeSkill(agentsRoot, "dup-diff", manifest("dup-diff", "two"), newer);
  await writeSkill(path.join(codexRoot, ".system"), "sys-skill", manifest("sys-skill", "bundled"), newer);
  await writeFixtureFile(codexRoot, ".system/.codex-system-skills.marker", "marker");
  await writeSkill(codexRoot, "sys-skill", manifest("sys-skill", "local"), older);
  await writeSkill(claudeRoot, "sys-skill", manifest("sys-skill", "local"), older);
  await writeSkill(path.join(mirasimRoot, "synced", "bucket"), "synced-skill", manifest("synced-skill", "mirasim"), newer);
  await writeSkill(codexRoot, "synced-skill", manifest("synced-skill", "codex"), older);

  const scan = await scanAll({
    agents: [
      agent("codex", [codexRoot, vendorRoot, agentsRoot]),
      agent("claude", [claudeRoot, mirasimRoot]),
      agent("workbuddy", [workbuddyRoot]),
    ],
    visibleAgentIds: ["codex", "claude", "workbuddy"],
    primaryAgentIds: ["codex", "claude"],
  }, { homeDirectory: home });
  const skill = (name) => scan.skills.find((item) => item.name === name);

  assert.deepEqual(scan.primaryAgentIds, ["codex", "claude"]);
  assert.deepEqual(scan.effectivePrimaryAgentIds, ["codex", "claude"]);
  assert.equal(skill("same").primaryStatus, "ok");
  assert.equal(skill("same").inPrimary, true);
  assert.deepEqual(skill("same").installedPrimary, ["codex", "claude"]);
  assert.equal(skill("same").newest, null);

  const byVersion = skill("by-version");
  assert.equal(byVersion.primaryStatus, "differs");
  assert.equal(byVersion.newest.agentId, "codex");
  assert.equal(byVersion.newest.version, "1.10.0");
  assert.deepEqual(byVersion.behind, ["claude"]);
  assert.equal(byVersion.diverged, false);
  assert.equal(byVersion.status, "conflict");

  const byMtime = skill("by-mtime");
  assert.equal(byMtime.newest.agentId, "claude");
  assert.equal(byMtime.newest.modifiedAt, newer.toISOString());
  assert.deepEqual(byMtime.behind, ["codex"]);
  assert.equal(skill("tie").diverged, true);

  const vendorOnly = skill("vendor-only-diff");
  assert.equal(vendorOnly.primaryStatus, "ok");
  assert.deepEqual(vendorOnly.managed, ["codex"]);
  const vendorInstance = vendorOnly.instances.find((instance) => instance.agentId === "codex");
  assert.equal(vendorInstance.source, "codex-vendor-import");
  assert.equal(vendorInstance.managed, true);
  assert.notEqual(vendorInstance.readOnly, true);

  // Vendor copies are managed, so a local copy plus a vendor import is not a duplicate.
  assert.deepEqual(skill("dup").duplicates, []);
  assert.equal(skill("dup").primaryStatus, "ok");
  assert.deepEqual(skill("dup-same").duplicates, [{ agentId: "codex", count: 2, identical: true }]);
  assert.equal(skill("dup-same").primaryStatus, "ok");
  assert.deepEqual(skill("dup-diff").duplicates, [{ agentId: "codex", count: 2, identical: false }]);
  assert.equal(skill("dup-diff").primaryStatus, "differs");

  const mixed = skill("mixed-version");
  assert.equal(mixed.newest.agentId, "claude");
  assert.equal(mixed.newest.version, null);

  const system = skill("sys-skill");
  const systemInstance = system.instances.find((instance) => instance.source === "codex-system");
  assert.equal(systemInstance.managed, true);
  assert.equal(systemInstance.readOnly, true);
  assert.equal(system.primaryStatus, "ok");
  assert.deepEqual(system.duplicates, []);
  const synced = skill("synced-skill");
  const syncedInstance = synced.instances.find((instance) => instance.agentId === "claude");
  assert.equal(syncedInstance.source, "mirasim-synced");
  assert.equal(syncedInstance.managed, true);
  assert.equal(synced.primaryStatus, "ok");
  const elsewhere = skill("elsewhere");
  assert.equal(elsewhere.inPrimary, false);
  assert.equal(elsewhere.primaryStatus, "ok");
  assert.deepEqual(elsewhere.missingPrimary, ["codex", "claude"]);

  assert.deepEqual(scan.summary, {
    total: 12,
    inPrimary: 11,
    differs: 5,
    duplicates: { total: 2, identical: 1, differing: 1 },
    sharedRoots: 0,
  });
});

test("falls back to suggested primary agents from session activity", async (context) => {
  const home = await tempHome(context);
  const codexRoot = path.join(home, "codex-skills");
  const claudeRoot = path.join(home, "claude-skills");
  await writeSkill(codexRoot, "only-codex", manifest("only-codex"));
  await mkdir(claudeRoot, { recursive: true });
  for (const name of ["a", "b", "c"]) {
    await writeSessionFile(home, `.claude/projects/p/${name}.jsonl`, 1_000, new Date());
  }
  const config = { agents: [agent("codex", [codexRoot]), agent("claude", [claudeRoot])], visibleAgentIds: ["codex", "claude"] };
  const scan = await scanAll(config, { homeDirectory: home });
  assert.equal(scan.primaryAgentIds, null);
  assert.deepEqual(scan.suggestedPrimaryAgentIds, ["claude"]);
  assert.deepEqual(scan.effectivePrimaryAgentIds, ["claude"]);
  assert.equal(scan.agentActivity.agents.find((item) => item.agentId === "claude").files30d, 3);
  assert.equal(scan.skills[0].inPrimary, false);

  const quiet = await tempHome(context);
  const fallback = await scanAll(config, { homeDirectory: quiet });
  assert.deepEqual(fallback.suggestedPrimaryAgentIds, []);
  assert.deepEqual(fallback.effectivePrimaryAgentIds, ["codex", "claude"]);
});

test("detects shared roots, de-duplicates physical skills and plans a single write per real directory", { skip: !SYMLINKS }, async (context) => {
  const home = await tempHome(context);
  const mirasim = path.join(home, ".mirasim", "skills");
  const codexRoot = path.join(home, ".codex", "skills");
  const agentsRoot = path.join(home, ".agents", "skills");
  const claudeRoot = path.join(home, ".claude", "skills");
  const mirrorRoot = path.join(home, ".mirror", "skills");
  await writeSkill(mirasim, "shared-skill", manifest("shared-skill", "shared"));
  await writeSkill(codexRoot, "only-codex", manifest("only-codex", "codex"));
  for (const link of [agentsRoot, claudeRoot, mirrorRoot]) {
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(mirasim, link);
  }
  await symlink(path.join(mirasim, "shared-skill"), path.join(codexRoot, "shared-skill"));

  const config = {
    agents: [agent("codex", [codexRoot, agentsRoot]), agent("claude", [claudeRoot]), agent("mirror", [mirrorRoot])],
    visibleAgentIds: ["codex", "claude"],
    primaryAgentIds: ["codex", "claude"],
  };
  const scan = await scanAll(config, { homeDirectory: home });
  const realMirasim = await realpath(mirasim);

  assert.equal(scan.sharedRoots.length, 1);
  const [shared] = scan.sharedRoots;
  assert.match(shared.realPath, /\.mirasim[\\/]skills$/);
  assert.equal(shared.managedBy, "Mirasim");
  assert.deepEqual(shared.roots.map((root) => root.agentId).sort(), ["claude", "codex", "mirror"]);
  assert.equal(scan.summary.sharedRoots, 1);

  const sharedSkill = scan.skills.find((item) => item.name === "shared-skill");
  assert.equal(sharedSkill.instances.length, 2);
  const codexInstance = sharedSkill.instances.find((instance) => instance.agentId === "codex");
  const claudeInstance = sharedSkill.instances.find((instance) => instance.agentId === "claude");
  assert.equal(codexInstance.aliases.length, 1);
  assert.deepEqual(codexInstance.sharedWith, ["claude"]);
  assert.deepEqual(claudeInstance.sharedWith, ["codex"]);
  assert.equal(codexInstance.realPathId, claudeInstance.realPathId);
  assert.deepEqual(sharedSkill.duplicates, []);
  assert.equal(sharedSkill.primaryStatus, "ok");
  assert.equal(scan.agents.find((item) => item.id === "codex").installationCount, 2);
  assert.equal(scan.totals.installations, 2);
  assert.equal(scan.agents.find((item) => item.id === "mirror").installationCount, 1);

  const fullConfig = sanitizeConfig(config);
  const sourceOnly = scan.skills.find((item) => item.name === "only-codex").instances[0];
  const plan = await buildSyncPlan(fullConfig, scan, {
    sourceInstanceId: sourceOnly.id,
    targetAgentIds: ["claude", "mirror"],
    mode: "copy",
  });
  assert.deepEqual(plan.actions.map((action) => action.action), ["create", "noop"]);
  assert.deepEqual(plan.actions[0].alsoVisibleTo, ["codex", "mirror"]);
  assert.equal(plan.actions[1].reason, "shared-with-target");
  assert.equal(plan.actions[1].sharedWithAgentId, "claude");
  assert.equal(plan.sharedDestinations.length, 1);
  assert.deepEqual(plan.sharedDestinations[0].agentIds, ["claude", "mirror"]);
  assert.equal(path.dirname(path.resolve(plan.actions[0].realDestination.replace(/^~/, home))), realMirasim);

  const symlinkPlan = await buildSyncPlan(fullConfig, scan, {
    sourceInstanceId: codexInstance.id,
    targetAgentIds: ["claude", "mirror"],
    mode: "symlink",
  });
  assert.deepEqual(symlinkPlan.actions.map((action) => action.action), ["noop", "noop"]);
  assert.deepEqual(symlinkPlan.actions.map((action) => action.reason), ["same-directory", "same-directory"]);
});
