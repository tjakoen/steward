// The templates a binary hands to BATCH's renderer (0010).
//
// Lives beside `render.ts` rather than in `build/`, which `.gitignore` excludes except for
// the two generated files named there — a test nobody checks in is a test nobody runs.
//
// 0009 shipped these by writing ten files into the data directory at boot, purely so a
// `readdirSync` had somewhere to look. BATCH 0.2.0 takes the templates directly, and
// `render.ts` passes them — so what has to be proved is that the embedded map really does
// drive the renderer, not just that it exists.
//
// The packaged half proves itself: `render.ts` reads every embedded path while its module
// body evaluates, so a binary that boots at all has already done it.

import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRenderer } from '@tjakoen/batch/render/render.ts';
import { COMPONENTS } from './build/assets.gen.ts';

const templates = Object.fromEntries(
  Object.entries(COMPONENTS).map(([file, path]) => [file.replace(/\.html$/, ''), readFileSync(path, 'utf8')]),
);

test('every embedded component is a hyphenated name with real markup behind it', () => {
  expect(Object.keys(templates).length).toBeGreaterThan(5);
  for (const [name, source] of Object.entries(templates)) {
    // BATCH only registers hyphenated names; a key without one would be silently dropped,
    // and a silently dropped component renders as an unknown element in the browser.
    expect(name).toContain('-');
    expect(source.length).toBeGreaterThan(10);
  }
});

test('a component renders from the embedded map alone, with no directory to walk', async () => {
  const { render } = createRenderer({ templates, missing: 'throw' });
  const html = await render('b-button', {}, { label: 'Push now', variant: 'soft' });

  expect(html).toContain('<button');
  expect(html).toContain('class="btn"');
  expect(html).toContain('Push now');
  expect(html).toContain('data-variant="soft"');
});

test('a page expands component tags, including self-closing ones, from the map', async () => {
  const { renderPage } = createRenderer({ templates, missing: 'ignore' });
  const html = await renderPage('<main><b-button label="Go"></b-button><b-badge label="link" /></main>', {});

  expect(html).not.toContain('<b-button');
  expect(html).not.toContain('<b-badge');
  expect(html).toContain('<button');
  expect(html).toContain('Go');
});
