// Generates `build/assets.gen.ts` — the manifest of every file the server used to read
// from disk at request time (0009).
//
// STEWARD is a server that reads its own source tree: `createStyleBundle` walks
// node_modules on a cold start, `makeStatic` resolves four directories per request, MILL
// reads `content/`, and `import.meta.resolve` locates PROOF's and CRUMB's assets. None of
// that exists inside a `bun build --compile` binary, and `import.meta.resolve` does not
// merely return the wrong answer there — it THROWS.
//
// The output is a list of `import … with { type: 'file' }` statements. That form is the
// whole reason this works: in a checkout it evaluates to the real path on disk, and in a
// binary to a `/$bunfs/root/…` path with the bytes embedded, and `Bun.file()` reads both.
// One code path, exercised by the same test run either way — not a packaging mode that
// only executes on a release machine and rots between releases.
//
// Run: `bun run gen:assets`. The result is CHECKED IN, and `build/assets.test.ts` fails
// when it is stale.

import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';

const ROOT = config.root;
const OUT = join(ROOT, 'build', 'assets.gen.ts');

/** Extensions a browser can be handed. `.ts`/`.d.ts`/`.md` sit beside them and are not. */
const SERVABLE = new Set(['.js', '.css', '.svg', '.woff2', '.woff', '.html', '.png', '.ico', '.json']);

const extOf = (f: string) => (f.includes('.') ? f.slice(f.lastIndexOf('.')) : '');

/** Every file under `dir`, recursively, as paths relative to it. Sorted, so runs match. */
function walk(dir: string, base = dir, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else out.push(relative(base, full));
  }
  return out.sort();
}

const exists = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** A POSIX-separator import specifier, relative to `build/`. Windows-safe generation. */
const spec = (abs: string) => {
  const rel = relative(join(ROOT, 'build'), abs).split(sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
};

interface Entry { key: string; abs: string }

const staticEntries: Entry[] = [];
const contentEntries: Entry[] = [];

// ---- HTTP-servable trees: the same prefixes `config.assetDirs` maps today ----
for (const [prefix, dir] of Object.entries({ ...config.assetDirs, '/fonts': config.fontsDir })) {
  if (!exists(dir)) continue;
  for (const rel of walk(dir)) {
    if (!SERVABLE.has(extOf(rel))) continue;
    staticEntries.push({ key: `${prefix}/${rel.split(sep).join('/')}`, abs: join(dir, rel) });
  }
}

// ---- PROOF's and CRUMB's own assets, resolved out of their packages ----
// These four are served from named routes rather than from a directory, and each is
// located today by `import.meta.resolve` — the call that throws inside a binary.
const PACKAGE_ASSETS: Record<string, string> = {
  '/proof.css': '@tjakoen/proof/board.css',
  '/proof-live.js': '@tjakoen/proof/board-live.js',
  '/crumb.css': '@tjakoen/crumb/crumb.css',
  '/crumb-live.js': '@tjakoen/crumb/crumb-live.js',
};
for (const [key, pkgSpec] of Object.entries(PACKAGE_ASSETS)) {
  staticEntries.push({ key, abs: fileURLToPath(import.meta.resolve(pkgSpec)) });
}

// ---- MILL content: rendered, never served raw, so it gets its own map ----
// Keys mirror the collection prefix so `embeddedSource('/help')` can select its own
// files. Two maps rather than one namespaced map on purpose: a prefix convention is one
// typo away from serving the changelog's raw Markdown from a URL nobody meant to expose.
for (const [prefix, dir] of Object.entries({
  '/help': join(config.contentDir, 'help'),
  '/changelog': config.contentDir,
})) {
  if (!exists(dir)) continue;
  for (const rel of walk(dir)) {
    if (extOf(rel) !== '.md') continue;
    if (rel.includes(sep)) continue;             // dirSource is flat; a nested .md is another collection's
    contentEntries.push({ key: `${prefix}/${rel}`, abs: join(dir, rel) });
  }
}

// ---- Component templates for BATCH's <b-*> renderer ----
//
// `createRenderer` finds these with its own `readdirSync` and then reads each with
// `Bun.file`. The read works from an embedded path; the WALK cannot, and it is the walk
// that ran first and took the whole binary down with an ENOENT on `components`.
//
// Left out, the registry would simply be empty — and an empty registry does not error, it
// passes `<b-button>` through to the browser as an unknown element. STEWARD writes plain
// markup today and uses none of these, but "works in dev, silently renders nothing in the
// binary" is the exact divergence this file exists to prevent. So they travel too, and
// `app/assets/components.ts` gives the walk a real directory to find them in.
const componentEntries: Entry[] = [];
for (const root of config.componentRoots) {
  if (!exists(root)) continue;
  for (const rel of walk(root)) {
    if (extOf(rel) !== '.html') continue;
    const name = rel.slice(rel.lastIndexOf(sep) + 1, -'.html'.length);
    if (!name.includes('-')) continue;           // hyphenated = a component, per the renderer
    componentEntries.push({ key: `${name}.html`, abs: join(root, rel) });
  }
}

// ---- The style bundle, in the exact order the dev-time bundle concatenates it ----
//
// `createStyleBundle` collects every root and then sorts ONCE, globally, over ABSOLUTE
// paths — so today's cascade order is a function of where node_modules happens to sit on
// disk. Inside the binary those paths are `/$bunfs/root/…` and sort differently. Recording
// the ORDER here, at generation time, is what keeps the cascade identical; re-sorting at
// runtime would load every rule and load them in the wrong sequence, with nothing to
// report and nothing to catch it but the eye. (Plan 0008 was an entire plan about rules
// winning by load order rather than by design. Not again.)
const bundle: string[] = [];
for (const root of config.styleRoots) {
  if (!exists(root)) continue;
  for (const rel of walk(root)) {
    if (extOf(rel) === '.css') bundle.push(join(root, rel));
  }
}
bundle.sort();

// ---- emit ----
const all = [...staticEntries, ...contentEntries, ...componentEntries, ...bundle.map((abs) => ({ key: '', abs }))];
const ids = new Map<string, string>();
for (const { abs } of all) if (!ids.has(abs)) ids.set(abs, `f${ids.size}`);

const dup = staticEntries.map((e) => e.key).filter((k, i, a) => a.indexOf(k) !== i);
if (dup.length) throw new Error(`Two files claim the same URL: ${dup.join(', ')}`);

const lines = [
  '// @ts-nocheck — see below.',
  '// GENERATED by scripts/gen-assets.ts — do not edit by hand.',
  '//',
  '// Every file the server serves, embedded. `bun run gen:assets` rewrites this, and',
  '// build/assets.test.ts fails when it is stale — a missed file is a 404 nobody sees',
  '// until a page renders unstyled on someone else\'s machine.',
  '//',
  '// `with { type: \'file\' }` makes an import evaluate to a PATH rather than to the',
  '// module. TypeScript has no representation for that: it resolves `./x.js` as a real',
  '// module and then objects that a script written for a browser has no types and no',
  '// default export. Both complaints are about an import this file never dereferences.',
  '// The three exports below are explicitly annotated, so every CONSUMER is still fully',
  '// typechecked — which is where a mistake would actually cost something.',
  '',
  ...[...ids].map(([abs, id]) => `import ${id} from '${spec(abs)}' with { type: 'file' };`),
  '',
  '/** URL path → the embedded file backing it. */',
  'export const ASSETS: Readonly<Record<string, string>> = {',
  ...staticEntries.map((e) => `  '${e.key}': ${ids.get(e.abs)},`),
  '};',
  '',
  '/** `<collection prefix>/<file>.md` → the embedded Markdown MILL renders. */',
  'export const CONTENT: Readonly<Record<string, string>> = {',
  ...contentEntries.map((e) => `  '${e.key}': ${ids.get(e.abs)},`),
  '};',
  '',
  '/** `<name>.html` → the embedded template for the `<name>` component tag. */',
  'export const COMPONENTS: Readonly<Record<string, string>> = {',
  ...componentEntries.map((e) => `  '${e.key}': ${ids.get(e.abs)},`),
  '};',
  '',
  '/** Component stylesheets, in the cascade order /components.css must preserve. */',
  'export const BUNDLE: readonly string[] = [',
  ...bundle.map((abs) => `  ${ids.get(abs)},`),
  '];',
  '',
];

export const generated = lines.join('\n');

if (import.meta.main) {
  await Bun.write(OUT, generated);
  console.log(
    `build/assets.gen.ts — ${staticEntries.length} served, ${contentEntries.length} content, `
      + `${componentEntries.length} components, ${bundle.length} in the bundle`,
  );
}
