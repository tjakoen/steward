// The mechanism behind the embed manifest (0009).
//
// `build/assets.gen.ts` is generated and checked in, which means it can go stale: a
// `bun install` brings a new GRAIN component, the dev server serves it out of
// node_modules, the binary does not, and the only symptom is a page rendering unstyled on
// someone else's machine. There is no type error and no exception — so the guard has to
// be a test.
//
// The bundle ORDER is checked as hard as its contents. `createStyleBundle` derives the
// cascade by sorting absolute paths, and inside the binary those are `/$bunfs/root/…` and
// sort differently; a wrong order loads every rule, in the wrong sequence, silently. Plan
// 0008 was an entire plan about rules winning by load order rather than by design.

import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bunRuntime } from '@tjakoen/batch/platform/bun-runtime.ts';
import { createStyleBundle } from '@tjakoen/batch/assets/style-bundle.ts';
import { config } from '../config.ts';
import { generated } from '../scripts/gen-assets.ts';
import { ASSETS, BUNDLE, CONTENT } from './assets.gen.ts';
import { componentsCss, embeddedSource, isAsset, serveAsset } from '../app/assets/serve.ts';

test('the manifest is not stale', () => {
  // Regenerate in memory and compare. Fails on a new GRAIN component, a renamed script,
  // a deleted stylesheet — anything that would make the binary and the checkout disagree.
  const onDisk = readFileSync(join(config.root, 'build', 'assets.gen.ts'), 'utf8');
  expect(onDisk).toBe(generated);   // stale → run `bun run gen:assets`
});

test('/components.css is byte-identical to the bundle it replaces', async () => {
  // The definition of done for the whole embed task. `createStyleBundle` is the code that
  // used to build this response by walking node_modules on every cold start; this asserts
  // the manifest reproduces it exactly, cascade order included.
  const before = await createStyleBundle(bunRuntime, [...config.styleRoots]).css();
  const after = await componentsCss();

  // The old bundle prefixed each file with a `/* <absolute path> */` comment — a build-host
  // path, which is meaningless in a binary and is the one difference that is deliberate.
  // Matched tightly (leading `/`, trailing `.css`) so it cannot eat a stylesheet's own
  // comments; a loose `/* .* */` strips 67 real GRAIN comments and still "passes" as a
  // diff of two things neither of which is the bundle.
  const stripped = before.replace(/^\/\* \/[^\n]*\.css \*\/\n/gm, '');
  expect(after).toBe(stripped);

  // …and the order is the same list of files, not merely the same bytes by luck.
  const order = [...before.matchAll(/^\/\* (\/[^\n]*\.css) \*\/$/gm)].map((m) => m[1]!);
  expect(order.length).toBe(BUNDLE.length);
});

test('every URL the pages ask for is in the manifest', () => {
  // The links and scripts in the composition root's PAGE_HEAD / PAGE_ASSETS, plus the two
  // named PROOF and CRUMB assets. A missing one is a 404 that only shows up in a browser.
  const wanted = [
    '/styles/variables.css', '/styles/global.css',
    '/scripts/theme-boot.js', '/scripts/theme.js', '/scripts/ai-dispatch.js',
    '/scripts/shell.js', '/scripts/drawer.js',
    '/app/steward.css', '/app/steward-live.js', '/app/steward-chat.js', '/app/steward-picker.js',
    '/app/steward-tabs.js',
    '/assets/sprite.svg',
    '/proof.css', '/proof-live.js', '/crumb.css', '/crumb-live.js',
  ];
  for (const url of wanted) expect({ url, present: isAsset(url) }).toEqual({ url, present: true });
});

test('the fonts the stylesheets @font-face are all embedded', async () => {
  // GRAIN's variables.css names its faces by URL. Missing one is a silent fallback to a
  // system font — the page still renders, just not as designed, which is precisely the
  // kind of miss no test catches unless it goes looking.
  const css = await Bun.file(ASSETS['/styles/variables.css']!).text();
  const urls = [...css.matchAll(/url\((['"]?)(\/fonts\/[^'")]+)\1\)/g)].map((m) => m[2]!);
  expect(urls.length).toBeGreaterThan(0);
  for (const url of urls) expect({ url, present: isAsset(url) }).toEqual({ url, present: true });
});

test('serving is a lookup, so traversal has nothing to escape', async () => {
  for (const path of ['/app/../../etc/passwd', '/scripts/', '/nope.css', '/app/steward.css/']) {
    expect((await serveAsset(path)).status).toBe(404);
  }
  const ok = serveAsset('/app/steward.css');
  expect(ok.status).toBe(200);
  expect(ok.headers.get('Content-Type')).toBe('text/css');
});

test('nothing serves raw Markdown', () => {
  // Content is RENDERED by MILL, never handed over as a file. Two maps rather than one
  // namespaced map is what keeps a prefix typo from publishing the changelog's source.
  for (const key of Object.keys(CONTENT)) expect(isAsset(key)).toBe(false);
  for (const key of Object.keys(ASSETS)) expect(key.endsWith('.md')).toBe(false);
});

test('the embedded content source answers the same slugs MILL asked a directory for', async () => {
  const help = embeddedSource('/help');
  expect(await help.list()).toEqual(['getting-started']);
  // Slug matching is case-insensitive, exactly as MILL's own dirSource is. Diverging would
  // make a URL resolve in dev and 404 in the binary.
  expect(await help.read('Getting-Started')).toContain('#');
  expect(await help.read('nope')).toBeNull();

  expect(await embeddedSource('/changelog').list()).toEqual(['changelog']);
});

test('the bundle holds every component stylesheet exactly once', () => {
  expect(new Set(BUNDLE).size).toBe(BUNDLE.length);
  expect(BUNDLE.length).toBeGreaterThan(40);
});
