import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startTestServer } from "./fixtures/server.mjs";
import { writeFixtureFile } from "./fixtures/smartorder.mjs";

const SKIP = process.platform === "win32";
const manifest = (name, body) => `---\nname: ${name}\ndescription: ${name} fixture\n---\n# ${name}\n\n${body}\n`;

async function setupHome(context) {
  const home = await mkdtemp(path.join(tmpdir(), "sync-write-through-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const roots = {
    codex: path.join(home, ".codex", "skills"),
    claude: path.join(home, ".claude", "skills"),
    workbuddy: path.join(home, ".workbuddy", "skills"),
    mirror: path.join(home, ".mirror", "skills"),
  };
  return { home, roots };
}

async function writeConfig(home, agents, visibleAgentIds) {
  await writeFixtureFile(
    home,
    ".agent-skill-manager/config.json",
    JSON.stringify({
      version: 3,
      syncMode: "copy",
      dismissedAgentIds: ["gemini", "cursor", "smartorder"],
      visibleAgentIds,
      agents: Object.entries(agents).map(([id, paths]) => ({
        id,
        name: id,
        shortName: id.slice(0, 2).toUpperCase(),
        color: "#8fc9ef",
        paths,
      })),
    }),
  );
}

async function sync(server, body) {
  const plan = await server.requestJson("/api/sync", {
    method: "POST",
    body: JSON.stringify({ ...body, dryRun: true }),
  });
  const result = await server.requestJson("/api/sync", {
    method: "POST",
    headers: { "x-skill-manager-confirm": "yes" },
    body: JSON.stringify({ ...body, dryRun: false, confirm: true }),
  });
  return { plan, result };
}

function instanceOf(scan, skillName, agentId) {
  return scan.skills
    .find((skill) => skill.name === skillName)
    .instances.find((instance) => instance.agentId === agentId);
}

test("writes through a leaf symlink into another Agent's root and backs up the real content", { skip: SKIP }, async (context) => {
  const { home, roots } = await setupHome(context);
  await writeFixtureFile(roots.codex, "foo/SKILL.md", manifest("foo", "version one"));
  await writeFixtureFile(roots.workbuddy, "foo/SKILL.md", manifest("foo", "version two"));
  await mkdir(roots.claude, { recursive: true });
  await symlink(path.join(roots.codex, "foo"), path.join(roots.claude, "foo"));
  await writeConfig(home, {
    codex: [roots.codex],
    claude: [roots.claude],
    workbuddy: [roots.workbuddy],
  }, ["codex", "claude", "workbuddy"]);
  const server = await startTestServer(context, home);
  const scan = await server.requestJson("/api/scan?force=1");
  const source = instanceOf(scan, "foo", "workbuddy");

  const { plan, result } = await sync(server, {
    sourceInstanceId: source.id,
    targetAgentIds: ["claude"],
    mode: "copy",
  });
  const [planned] = plan.actions;
  assert.equal(planned.action, "replace");
  assert.equal(planned.viaSymlink, true);
  assert.equal(planned.realDestination, "~/.codex/skills/foo");
  assert.deepEqual(planned.alsoVisibleTo, ["codex"]);
  assert.equal("writePath" in planned, false);
  assert.equal(result.actions[0].result, "completed");

  assert.equal((await lstat(path.join(roots.claude, "foo"))).isSymbolicLink(), true);
  assert.match(await readFile(path.join(roots.codex, "foo", "SKILL.md"), "utf8"), /version two/);
  assert.match(await readFile(path.join(roots.claude, "foo", "SKILL.md"), "utf8"), /version two/);
  const backup = path.join(home, result.actions[0].backup.slice(2));
  assert.equal((await lstat(backup)).isDirectory(), true);
  assert.match(await readFile(path.join(backup, "SKILL.md"), "utf8"), /version one/);
});

test("plans one write for Agents that share a root alias and none for a link back to the source", { skip: SKIP }, async (context) => {
  const { home, roots } = await setupHome(context);
  const mirasim = path.join(home, ".mirasim", "skills");
  await mkdir(mirasim, { recursive: true });
  for (const link of [roots.claude, roots.mirror]) {
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(mirasim, link);
  }
  await writeFixtureFile(roots.codex, "bar/SKILL.md", manifest("bar", "codex bar"));
  await writeFixtureFile(roots.codex, "baz/SKILL.md", manifest("baz", "codex baz"));
  await symlink(path.join(roots.codex, "baz"), path.join(mirasim, "baz"));
  await writeConfig(home, {
    codex: [roots.codex],
    claude: [roots.claude],
    mirror: [roots.mirror],
  }, ["codex", "claude", "mirror"]);
  const server = await startTestServer(context, home);
  const scan = await server.requestJson("/api/scan?force=1");

  const { plan, result } = await sync(server, {
    sourceInstanceId: instanceOf(scan, "bar", "codex").id,
    targetAgentIds: ["claude", "mirror"],
    mode: "copy",
  });
  assert.deepEqual(plan.actions.map((action) => action.action), ["create", "noop"]);
  assert.equal(plan.actions[1].reason, "shared-with-target");
  assert.deepEqual(plan.sharedDestinations[0].agentIds, ["claude", "mirror"]);
  assert.deepEqual(result.actions.map((action) => action.result), ["completed", "skipped"]);
  assert.equal((await lstat(roots.claude)).isSymbolicLink(), true);
  assert.deepEqual((await readdir(mirasim)).filter((name) => !name.startsWith(".")).sort(), ["bar", "baz"]);
  assert.match(await readFile(path.join(mirasim, "bar", "SKILL.md"), "utf8"), /codex bar/);

  for (const mode of ["copy", "symlink"]) {
    const linked = await sync(server, {
      sourceInstanceId: instanceOf(scan, "baz", "codex").id,
      targetAgentIds: ["claude"],
      mode,
    });
    assert.equal(linked.plan.actions[0].action, "noop");
    assert.equal(linked.plan.actions[0].reason, "same-directory");
    assert.equal(linked.result.actions[0].result, "skipped");
    assert.equal((await lstat(path.join(mirasim, "baz"))).isSymbolicLink(), true);
    assert.equal(await realpath(path.join(mirasim, "baz")), await realpath(path.join(roots.codex, "baz")));
  }
});

test("refuses links that escape every Agent root and destinations nested in the source", { skip: SKIP }, async (context) => {
  const { home, roots } = await setupHome(context);
  const outside = path.join(home, "Workspace", "ext");
  await writeFixtureFile(outside, "SKILL.md", manifest("ext", "outside copy"));
  await writeFixtureFile(roots.codex, "ext/SKILL.md", manifest("ext", "codex copy"));
  await writeFixtureFile(roots.codex, "outer/SKILL.md", manifest("outer", "outer"));
  await mkdir(roots.claude, { recursive: true });
  await symlink(outside, path.join(roots.claude, "ext"));
  await writeConfig(home, {
    codex: [roots.codex],
    claude: [roots.claude],
    nested: [path.join(roots.codex, "outer", "inner")],
  }, ["codex", "claude", "nested"]);
  const server = await startTestServer(context, home);
  const scan = await server.requestJson("/api/scan?force=1");

  const escaped = await server.request("/api/sync", {
    method: "POST",
    body: JSON.stringify({
      sourceInstanceId: instanceOf(scan, "ext", "codex").id,
      targetAgentIds: ["claude"],
      dryRun: true,
    }),
  });
  assert.equal(escaped.status, 400);
  const escapedError = (await escaped.json()).error;
  assert.match(escapedError, /软链接.*不在任何已配置的 Agent 技能目录内/);
  assert.doesNotMatch(escapedError, new RegExp(home.replaceAll("/", "\\/")));

  const nested = await server.request("/api/sync", {
    method: "POST",
    body: JSON.stringify({
      sourceInstanceId: instanceOf(scan, "outer", "codex").id,
      targetAgentIds: ["nested"],
      dryRun: true,
    }),
  });
  assert.equal(nested.status, 400);
  assert.match((await nested.json()).error, /互相包含/);
  assert.match(await readFile(path.join(outside, "SKILL.md"), "utf8"), /outside copy/);
});

test("never copies links that escape the source skill and reports them in plan and result", { skip: SKIP }, async (context) => {
  const { home, roots } = await setupHome(context);
  const secret = await writeFixtureFile(home, "private/id_rsa", "PRIVATE-KEY-MATERIAL");
  const skill = path.join(roots.codex, "leaky");
  await writeFixtureFile(skill, "SKILL.md", manifest("leaky", "body"));
  await symlink(secret, path.join(skill, "notes"));
  await symlink(path.join(skill, "SKILL.md"), path.join(skill, "alias.md"));
  await symlink(skill, path.join(skill, "loop"));
  await mkdir(roots.claude, { recursive: true });
  await writeConfig(home, { codex: [roots.codex], claude: [roots.claude] }, ["codex", "claude"]);
  const server = await startTestServer(context, home);
  const scan = await server.requestJson("/api/scan?force=1");

  const { plan, result } = await sync(server, {
    sourceInstanceId: instanceOf(scan, "leaky", "codex").id,
    targetAgentIds: ["claude"],
    mode: "copy",
  });
  const expected = [
    { path: "loop", reason: "loop" },
    { path: "notes", reason: "outside" },
  ];
  assert.deepEqual(plan.actions[0].skippedLinks, expected);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /已跳过 2 个/);
  assert.deepEqual(result.actions[0].skippedLinks, expected);
  const target = path.join(roots.claude, "leaky");
  assert.deepEqual((await readdir(target)).sort(), ["SKILL.md", "alias.md"]);
  assert.equal((await lstat(path.join(target, "alias.md"))).isFile(), true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-KEY-MATERIAL/);
});
