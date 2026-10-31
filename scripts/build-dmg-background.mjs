#!/usr/bin/env node
// Renders the DMG window background: resources/dmg-background.png (560×380) and
// resources/dmg-background@2x.png (Retina). dmg-builder combines the pair into one TIFF.
// The icon positions match dmg.contents in electron-builder.yml (150,190) and (410,190).
// Uses sharp (installed with Next.js) and the system's Chinese UI font:
// `node scripts/build-dmg-background.mjs`, then commit both PNG files.
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIDTH = 560;
const HEIGHT = 380;
const LINE = "拖到「应用程序」· 第一次打开请看 README";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fbfbf9"/>
      <stop offset="1" stop-color="#f1f1ec"/>
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  <g fill="none" stroke="#a9aaa6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
    <path d="M226 190 H330"/>
    <path d="M318 178 L332 190 L318 202"/>
  </g>
  <line x1="40" y1="296" x2="${WIDTH - 40}" y2="296" stroke="#e2e2dc" stroke-width="1"/>
  <text x="${WIDTH / 2}" y="330" text-anchor="middle" fill="#45464b"
    font-family="PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans CJK SC, sans-serif"
    font-size="15" font-weight="500">${LINE}</text>
</svg>`;

for (const [scale, name] of [
  [1, "dmg-background.png"],
  [2, "dmg-background@2x.png"],
]) {
  const output = path.join(root, "resources", name);
  await sharp(Buffer.from(svg), { density: 72 * scale })
    .resize(WIDTH * scale, HEIGHT * scale)
    .png({ compressionLevel: 9 })
    .toFile(output);
  console.log(`Wrote ${path.relative(root, output)}`);
}
