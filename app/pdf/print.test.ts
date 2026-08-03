import { test, expect, afterAll } from 'bun:test';
import { printToPdf, closeBrowser, printParams, resolveChrome } from './print.ts';

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

// ---- 0013: the options that make a page footer possible ---------------------

// scripts/make-icon.ts and every pre-0013 caller share this path. It has to stay
// exactly what it was, or the icon script starts printing A4 pages.
test('the no-options call is unchanged: CSS page size, no header or footer', () => {
  expect(printParams()).toEqual({ printBackground: true, preferCSSPageSize: true });
});

test('margins move out of @page and into the call, in inches', () => {
  const p = printParams({ margins: { top: 18, right: 16, bottom: 22, left: 16 } });
  expect(p.preferCSSPageSize).toBe(false);
  expect(p.marginTop).toBeCloseTo(18 / 25.4, 5);
  expect(p.marginBottom).toBeCloseTo(22 / 25.4, 5);
  // Losing preferCSSPageSize means losing @page's A4 too — Chrome would default
  // to Letter, so the paper has to be stated.
  expect(p.paperWidth).toBeCloseTo(210 / 25.4, 5);
  expect(p.paperHeight).toBeCloseTo(297 / 25.4, 5);
});

// The trap: displayHeaderFooter with only ONE template restores Chrome's stock
// other one — the document title and today's date, on a branded document.
test('a footer alone still blanks the header rather than inheriting Chrome’s', () => {
  const p = printParams({ footerTemplate: '<div>x</div>' });
  expect(p.displayHeaderFooter).toBe(true);
  expect(p.footerTemplate).toBe('<div>x</div>');
  expect(p.headerTemplate).toBe('<span></span>');
});

test('no template at all means no header/footer machinery', () => {
  expect(printParams({ margins: { top: 1, right: 1, bottom: 1, left: 1 } }).displayHeaderFooter)
    .toBeUndefined();
});
