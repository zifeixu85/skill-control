#!/usr/bin/env node
// Renders resources/icon.svg to resources/icon.png (1024 px, used by electron-builder
// for macOS, Windows and Linux). The dark background gradient is redrawn with dithering
// because an 8-bit SVG render shows visible bands at Dock sizes.
// Uses sharp, which is installed with Next.js: `node scripts/build-icon.mjs`.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "resources/icon.svg");
const output = path.join(root, "resources/icon.png");

const SIZE = 1024;
const SHAPE = { top: 100, height: 824 };
const GRADIENT_TOP = [0x30, 0x32, 0x35];
const GRADIENT_BOTTOM = [0x13, 0x14, 0x16];

const svg = await readFile(source, "utf8");
const hideGroup = (text, id) => {
  const marker = `<g id="${id}">`;
  if (!text.includes(marker)) throw new Error(`icon.svg is missing ${marker}`);
  return text.replace(marker, `<g id="${id}" display="none">`);
};
const render = (text) => sharp(Buffer.from(text)).resize(SIZE, SIZE).png().toBuffer();

// Background shape alone (no shadow) gives the anti-aliased mask for the gradient.
const shapeOnly = svg
  .replace(/ filter="url\(#shadow\)"/, "")
  .replace(/fill="url\(#bg\)"/, 'fill="#000000"');
const mask = await sharp(await render(hideGroup(shapeOnly, "glyph")))
  .extractChannel(3)
  .raw()
  .toBuffer();

const pixels = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y += 1) {
  const t = Math.min(1, Math.max(0, (y - SHAPE.top) / SHAPE.height));
  for (let x = 0; x < SIZE; x += 1) {
    const index = y * SIZE + x;
    // Triangular dither of about one 8-bit step hides gradient banding.
    const noise = Math.random() + Math.random() - 1;
    for (let channel = 0; channel < 3; channel += 1) {
      const value = GRADIENT_TOP[channel] + (GRADIENT_BOTTOM[channel] - GRADIENT_TOP[channel]) * t;
      pixels[index * 4 + channel] = Math.max(0, Math.min(255, Math.round(value + noise)));
    }
    pixels[index * 4 + 3] = mask[index];
  }
}
const gradient = await sharp(pixels, { raw: { width: SIZE, height: SIZE, channels: 4 } })
  .png()
  .toBuffer();

await sharp(await render(hideGroup(svg, "glyph")))
  .composite([{ input: gradient }, { input: await render(hideGroup(svg, "base")) }])
  .png({ compressionLevel: 9 })
  .toFile(output);
console.log(`Wrote ${path.relative(root, output)}`);
