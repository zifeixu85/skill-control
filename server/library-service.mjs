import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { dumpYaml, parseYamlSafe, readYamlFile } from "./config-files.mjs";
import { isWithin, object } from "./fs-safe.mjs";
import { hermesHomeFor } from "./hermes.mjs";
import { createLibraryManager } from "./library-plan.mjs";
import { readLibrary } from "./library.mjs";
import { commandEnv as defaultCommandEnv, runCommand } from "./update-apply.mjs";
import { findGitCheckout } from "./update-sources.mjs";

/**
 * The library for the HTTP routes: read-only view plus plan / apply / restore. Paths in
 * external tools' hands (git checkouts such as gstack, app support folders, anything
 * outside the home) are never moved.
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

  async function view() {
    const publicView = { ...(await readLibrary({ config: await getConfig(), homeDirectory, homes, stateDirectory })) };
    delete publicView.internal;
    return { ...publicView, trash: await manager.listTrash() };
  }

  return { view, plan: manager.plan, apply: manager.apply, restore: manager.restore, readInternal: () => getConfig().then((config) => readLibrary({ config, homeDirectory, homes, stateDirectory })) };
}
