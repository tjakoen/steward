import { test, expect, afterAll } from 'bun:test';
import { printToPdf, closeBrowser, resolveChrome } from './print.ts';

const hasChrome = resolveChrome() !== null;
// CI-safe: the CDP round-trip only runs where a Chrome/Chromium binary exists.
const chromeTest = hasChrome ? test : test.skip;

afterAll(async () => { await closeBrowser(); });

chromeTest('printToPdf returns a %PDF-prefixed buffer', async () => {
  const bytes = await printToPdf('<!doctype html><title>t</title><h1>Hello PDF</h1>');
  expect(bytes.byteLength).toBeGreaterThan(0);
  // PDF magic number: 0x25 0x50 0x44 0x46 = "%PDF".
  expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('%PDF');
}, 30_000);

test('resolveChrome returns a string path or null', () => {
  const p = resolveChrome();
  expect(p === null || typeof p === 'string').toBe(true);
});
