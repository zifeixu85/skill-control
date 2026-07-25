import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, "..");
const OUTPUT_DIRECTORY = path.join(PROJECT_DIRECTORY, "desktop", "runtime");
const OUTPUT_FILE = path.join(OUTPUT_DIRECTORY, "vinext-prod-server.mjs");
const ENTRY_FILE = fileURLToPath(import.meta.resolve("vinext/server/prod-server"));

await mkdir(OUTPUT_DIRECTORY, { recursive: true });
await build({
  entryPoints: [ENTRY_FILE],
  outfile: OUTPUT_FILE,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  minify: false,
  legalComments: "eof",
  logLevel: "info",
});
