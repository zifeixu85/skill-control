import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createAutoLinker, pairKey } from "./auto-link.mjs";
import { dumpYaml, parseYamlSafe, readYamlFile } from "./config-files.mjs";
import { isWithin, object } from "./fs-safe.mjs";
import { hermesHomeFor } from "./hermes.mjs";
import { createLibraryManager } from "./library-plan.mjs";
import { readLibrary } from "./library.mjs";
import { commandEnv as defaultCommandEnv, runCommand } from "./update-apply.mjs";
import { findGitCheckout } from "./update-sources.mjs";

/**
 * The library for the HTTP routes and the CLI: read-only view plus plan / apply / restore,
 * auto-link (server/auto-link.mjs) and installs through the library. Paths in external
 * tools' hands (git checkouts such as gstack, app support folders, anything outside the
 * home) are never moved. `readOnly` refuses every write (the CLI's --read-only mode).
 */
export function createLibraryService({
  homeDirectory = homedir(),
  homes = [homeDirectory],
  stateDirectory,
  backupDirectory,
  historyFile,
  getConfig,
  findCommand = async () => null,
  run = runCommand,
  commandEnv = defaultCommandEnv,
  platform = process.platform,
  fsImpl,
  saveAutoLinkSettings = async () => {
    throw new Error("这里不能修改自动接入设置。");
  },
  autoLink: autoLinkOptions = {},
  readOnly = false,
  origin = "app",
}) {
  const hermesConfigFile = () => path.join(hermesHomeFor(homeDirectory), "config.yaml");
  const hermesSkills = async () => object(object((await readYamlFile(hermesConfigFile())).value).skills);

  const context = {
    homeDirectory,
    homes,
    stateDirectory,
    backupDirectory,
    historyFile,
    getConfig,
    findCommand,
    run,
    commandEnv,
    platform,
    fsImpl,
    readOnly,
    // Manual links / unlinks keep auto-link's bookkeeping (handled pairs, tombstones) current.
    onApplied: (payload) => autoLinker.onApplied(payload),
    async isExternalPath(real) {
      if (!isWithin(homeDirectory, real)) return true;
      if (isWithin(path.join(homeDirectory, "Library", "Application Support"), real)) return true;
      return Boolean(await findGitCheckout(real, homeDirectory, 6));
    },
    async hermesConfiguredDirs() {
      const dirs = (await hermesSkills()).external_dirs;
      return Array.isArray(dirs) ? dirs : typeof dirs === "string" ? [dirs] : [];
    },
    async hermesDisabled() {
      const list = (await hermesSkills()).disabled;
      return Array.isArray(list) ? list.filter((name) => typeof name === "string") : [];
    },
    /** `hermes config set …` with a snapshot of config.yaml first, so the change can be undone. */
    hermesCommandOps(file, args) {
      const config = hermesConfigFile();
      const snapshot = path.join(backupDirectory, "hermes-config", `config-${Date.now()}.yaml`);
      return [
        { op: "backup-file", from: config, to: snapshot },
        { op: "command", file, args, restoreFile: { path: config, backup: snapshot } },
      ];
    },
    /** Without the hermes CLI: a YAML edit of config.yaml (comments are not kept), with backup and diff. */
    async hermesYamlOps(next) {
      const file = hermesConfigFile();
      const text = await readFile(file, "utf8").catch(() => "");
      const value = object(parseYamlSafe(text));
      value.skills = { ...object(value.skills), external_dirs: next };
      return [{
        op: "write",
        path: file,
        content: dumpYaml(value),
        backup: path.join(backupDirectory, "hermes-config", `config-${Date.now()}.yaml`),
        diff: `+ skills.external_dirs: ${JSON.stringify(next)}（未找到 hermes 命令，改为直接编辑 YAML，注释不会保留）`,
      }];
    },
  };
  const manager = createLibraryManager(context);
  const autoLinker = createAutoLinker({
    homeDirectory,
    stateDirectory,
    manager,
    getConfig,
    saveSettings: saveAutoLinkSettings,
    readOnly,
    label: origin === "cli" ? "skill-control CLI" : "Skill Control 自动接入",
    ...autoLinkOptions,
  });

  /** GET /api/library: the view plus `autoLink` and per-pair auto-link flags on each fanout. */
  async function view() {
    const config = await getConfig();
    const library = await readLibrary({ config, homeDirectory, homes, stateDirectory });
    const { block, flags } = await autoLinker.describe(config, library.internal);
    const publicView = { ...library };
    delete publicView.internal;
    publicView.entries = publicView.entries.map((entry) => ({
      ...entry,
      fanout: Object.fromEntries(
        Object.entries(entry.fanout).map(([agentId, item]) => {
          const flag = flags.get(pairKey(agentId, entry.name)) || {};
          return [agentId, { ...item, autoLinkable: Boolean(flag.autoLinkable), ...(flag.catchUp ? { catchUp: true } : {}), ...(flag.skipped ? { skipped: true } : {}) }];
        }),
      ),
    }));
    return { ...publicView, autoLink: block, trash: await manager.listTrash() };
  }

  return {
    view,
    plan: (input) => manager.plan(input),
    apply: (input) => manager.apply({ ...input, origin }),
    restore: manager.restore,
    autoLink: autoLinker,
    snapshot: manager.snapshot,
    readInternal: () => getConfig().then((config) => readLibrary({ config, homeDirectory, homes, stateDirectory })),
  };
}
