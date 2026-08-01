// Produce assets/steward.ico for `bun build --compile --windows-icon` (0010).
//
// Run by hand, and the RESULT IS COMMITTED: CI has no Chrome to render one, and a build
// input that only exists on one laptop is not a build input.
//
//   bun scripts/make-icon.ts
//
// The rasteriser is the headless Chrome this project already drives for PDFs, so this
// adds no dependency. Hand it different artwork by editing `MARK` — the packer takes
// whatever comes back.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { packIco, type IconImage } from '../app/assets/ico.ts';
import { screenshotPng, closeBrowser } from '../app/pdf/print.ts';

/** Windows asks for these; anything else it scales. 256 is what large views use. */
const SIZES = [256, 128, 64, 48, 32, 16];

const OUT = join(dirname(import.meta.dir), 'assets', 'steward.ico');

/**
 * The mark: STEWARD's S on the default brand teal.
 *
 * Sized in `em` against the viewport so one document renders correctly at every size —
 * a 16px icon drawn from a 256px design is a smudge, and the whole reason to rasterise
 * each size separately is to avoid exactly that.
 */
const MARK = (size: number): string => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; width: ${size}px; height: ${size}px; background: transparent; }
  .mark {
    width: 100%; height: 100%; box-sizing: border-box;
    background: #1f4e5f;
    border-radius: ${Math.max(2, Math.round(size * 0.18))}px;
    display: flex; align-items: center; justify-content: center;
    font-family: Georgia, 'Times New Roman', serif;
    color: #f4efe6;
    font-size: ${Math.round(size * 0.62)}px;
    font-weight: 700;
    line-height: 1;
    /* Optical centring: a serif S sits high on its baseline. */
    padding-bottom: ${Math.round(size * 0.04)}px;
  }
</style></head><body><div class="mark">S</div></body></html>`;

const images: IconImage[] = [];
try {
  for (const size of SIZES) {
    images.push({ size, png: await screenshotPng(MARK(size), size) });
    console.log(`  rendered ${size}×${size}`);
  }
} finally {
  await closeBrowser();
}

mkdirSync(dirname(OUT), { recursive: true });
const ico = packIco(images);
writeFileSync(OUT, ico);
console.log(`${OUT} — ${images.length} sizes, ${ico.length} bytes`);
console.log('Commit it: CI cannot regenerate this.');
