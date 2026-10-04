import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./helpers/load-ts.mjs";

const updates = await loadTs("app/lib/updates.ts");

const payload = {
  checkedAt: "2026-10-04T08:00:00.000Z",
  hosts: ["api.github.com", "github.com"],
  allowedHosts: ["api.github.com", "github.com", "raw.githubusercontent.com"],
  github: { remaining: 55, resetAt: "2026-10-04T09:00:00.000Z" },
  counts: { "update-available": 1, conflict: 1 },
  units: [
    {
      unitKey: "skills-cli:acme/skills:old-skill",
      title: "old-skill",
      sourceType: "skills-cli",
      sourceLabel: "acme/skills（GitHub）",
      owner: "skill-control",
      confidence: "exact",
      instances: [{ agentId: "codex", path: "~/.agents/skills/old-skill" }, { agentId: "claude", path: "~/.claude/skills/old-skill" }],
      instanceCount: 2,
      status: "update-available",
      current: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      latest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      checkedAt: "2026-10-04T08:00:00.000Z",
      action: { kind: "self", label: "更新" },
    },
    { unitKey: "b", title: "both-skill", status: "conflict", action: { kind: "self", label: "更新" }, instances: [] },
    { unitKey: "c", title: "gstack", status: "weird-status", action: { kind: "guide", label: "查看步骤", command: "/gstack-upgrade" } },
    { title: "no key" },
  ],
  job: { state: "running", done: 3, total: 10, requests: 4, hosts: ["github.com"] },
};

test("updates view normalizes units, statuses, counts and the check job", () => {
  const data = updates.normalizeUpdates(payload);
  assert.equal(data.units.length, 3, "units without a key are dropped");
  assert.equal(data.units[2].status, "unchecked", "unknown statuses fall back to 未检查");
  assert.equal(data.units[2].action.command, "/gstack-upgrade");
  assert.equal(data.github.remaining, 55);
  assert.equal(data.job.state, "running");
  assert.equal(updates.actionableCount(data), 2);
  const groups = updates.groupUnits(data.units);
  assert.deepEqual(groups.map((group) => group.status), ["update-available", "conflict", "unchecked"]);
  assert.equal(updates.shortRevision(data.units[0].current), "aaaaaaa");
  assert.equal(updates.shortRevision("1.0.66"), "1.0.66");
  assert.equal(updates.unitForPaths(data.units, ["~/.claude/skills/old-skill"]).title, "old-skill");
  assert.equal(updates.unitForPaths(data.units, ["~/nope"]), null);
  for (const status of updates.STATUS_ORDER) assert.ok(updates.STATUS_LABELS[status] && updates.STATUS_HINTS[status]);
});

test("plans: choice, executable plan and guide shapes", () => {
  const choice = updates.normalizePlan({ requiresChoice: true, unitKey: "b", status: "conflict", choices: ["keep-local", "overwrite", "save-as", "bogus"], message: "改过" });
  assert.equal(choice.kind, "choice");
  assert.deepEqual(choice.choices, ["keep-local", "overwrite", "save-as"]);
  const plan = updates.normalizePlan({
    planId: "p1",
    unitKey: "a",
    kind: "self",
    expiresAt: "x",
    steps: [{ type: "replace", path: "~/.agents/skills/old-skill", backup: "~/.agent-skill-manager/backups/1", alsoVisibleTo: ["claude"] }],
    changes: { added: ["scripts/run.sh"], modified: ["SKILL.md"], removed: [] },
    notes: ["note"],
  });
  assert.equal(plan.kind, "plan");
  assert.equal(plan.action, "self");
  assert.deepEqual(plan.steps[0].alsoVisibleTo, ["claude"]);
  assert.deepEqual(plan.changes.added, ["scripts/run.sh"]);
  const guide = updates.normalizePlan({ planId: null, unitKey: "c", kind: "guide", steps: [], instructions: "在 Claude Code 里运行", command: "/gstack-upgrade" });
  assert.equal(guide.kind, "guide");
  assert.equal(guide.command, "/gstack-upgrade");  // A self / delegate answer without a plan id is never shown as a guide or confirmable.
  for (const kind of ["self", "delegate"]) {
    const broken = updates.normalizePlan({ planId: null, unitKey: "d", kind, steps: [{ type: "replace" }] });
    assert.equal(broken.kind, "incomplete", kind);
    assert.match(broken.message, /服务返回的计划不完整/);
  }
});

test("apply results and change lists", () => {
  const self = updates.normalizeApply({ kind: "self", changed: [{ agentId: "codex", path: "~/x", backup: "~/b" }], lockBackup: "~/lock", savedAs: null });
  assert.equal(self.ok, true);
  assert.equal(self.changed[0].backup, "~/b");
  const delegate = updates.normalizeApply({ kind: "delegate", commands: [{ command: "lark-cli update --json", exitCode: 1, stdout: "", stderr: "boom" }] });
  assert.equal(delegate.ok, false);
  const changes = updates.normalizeChanges({ source: "github", changes: [{ sha: "9".repeat(40), title: "Update", date: "2026-10-01" }] });
  assert.equal(changes.changes[0].title, "Update");
  assert.equal(updates.normalizeChanges({ error: { message: "额度用完" } }).error, "额度用完");
  assert.equal(updates.normalizeCheckJob({ state: "nonsense" }).state, "idle");
});
