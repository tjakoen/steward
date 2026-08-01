import { test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { packIco, readIco } from './ico.ts';

const fakePng = (marker: number, length = 40): Uint8Array => {
  const png = new Uint8Array(length);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  png[8] = marker;
  return png;
};

test('every image is recoverable, byte for byte, at the offset the directory names', () => {
  const images = [16, 32, 256].map((size) => ({ size, png: fakePng(size, 30 + size) }));
  const ico = packIco(images);
  const entries = readIco(ico);

  expect(entries.length).toBe(3);
  for (const entry of entries) {
    const source = images.find((i) => i.size === entry.size)!;
    expect(Array.from(ico.slice(entry.offset, entry.offset + entry.length))).toEqual(Array.from(source.png));
  }
});

test('the largest image leads, so Explorer does not pick 16px and stretch it', () => {
  const entries = readIco(packIco([16, 256, 48].map((size) => ({ size, png: fakePng(size) }))));
  expect(entries.map((e) => e.size)).toEqual([256, 48, 16]);
});

test('256 is stored as the byte 0, which is the format, not a bug', () => {
  const ico = packIco([{ size: 256, png: fakePng(1) }]);
  expect(ico[6]).toBe(0);
  expect(ico[7]).toBe(0);
  expect(readIco(ico)[0].size).toBe(256);
});

test('a payload that is not a PNG is refused rather than written', () => {
  expect(() => packIco([{ size: 32, png: new Uint8Array([1, 2, 3, 4]) }])).toThrow(/not a PNG/);
  expect(() => packIco([])).toThrow(/at least one/);
  expect(() => packIco([{ size: 512, png: fakePng(1) }])).toThrow(/out of range/);
});

test('the committed icon is a real ICO with the six sizes the build ships', () => {
  // Committed on purpose: CI has no Chrome to render one, and a build input that only
  // exists on one laptop is not a build input. Regenerate with `bun scripts/make-icon.ts`.
  const file = join(import.meta.dir, '..', '..', 'assets', 'steward.ico');
  expect(existsSync(file)).toBe(true);

  const entries = readIco(new Uint8Array(readFileSync(file)));
  expect(entries.map((e) => e.size)).toEqual([256, 128, 64, 48, 32, 16]);
  expect(entries.every((e) => e.length > 100)).toBe(true);
});
