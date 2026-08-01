// The collision guard (plan 0008). STEWARD's stylesheet is served AFTER GRAIN's,
// so any class name defined in both silently overrides a design-system component
// — and the override is partial, which is worse than a full one: GRAIN's other
// declarations survive and mix with STEWARD's. Twelve of these had accumulated by
// 0008 and four were doing visible damage. A rule with no mechanism drifts, so
// this test is the mechanism: it fails on class thirteen.
//
// To resolve a new collision, either adopt GRAIN's component (delete STEWARD's
// rules and change the markup) or rename STEWARD's class. ADOPTED_ANYWAY is for
// the deliberate, documented exceptions only.

import { test, expect } from 'bun:test';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { config } from '../../config.ts';

/**
 * Class names STEWARD is knowingly redefining, each with the plan that ends it.
 * Empty since 0007's `shell-collision` retired the last one (`app-shell`, now
 * adopted rather than redefined) — the doctrine is that it stays empty.
 */
const ADOPTED_ANYWAY = new Set<string>([]);

const STEWARD_CSS = join(config.root, 'frontend', 'client', 'steward.css');

/** Every .css under a directory tree, sorted — the same set the style bundle serves. */
function cssFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) cssFiles(full, out);
    else if (e.name.endsWith('.css')) out.push(full);
  }
  return out.sort();
}

/**
 * Class names this stylesheet DEFINES.
 *
 * Selector text only: a `.` inside a declaration (`url(./x.png)`, a font name in
 * a var fallback) is not a definition. Comments and strings go first, then the
 * text before every `{` is a selector unless it opens an at-rule — and an
 * at-rule's BODY is walked all the same, which is how `@media` nesting is read.
 */
export function definedClasses(css: string): Set<string> {
  const clean = css
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');

  const found = new Set<string>();
  for (const chunk of clean.split('}')) {
    // Everything before a `{` is a prelude, everything after the last one is a
    // declaration body. A nested block (`@media (…) { .x { … }`) yields two
    // preludes in the same chunk, which is why this splits rather than indexes.
    const preludes = chunk.split('{');
    preludes.pop();
    for (const prelude of preludes) {
      // At-rules declare nothing themselves; the block they wrap is a prelude
      // of its own.
      if (prelude.trimStart().startsWith('@')) continue;
      for (const m of prelude.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) found.add(m[1]!);
    }
  }
  return found;
}

async function grainClasses(): Promise<Set<string>> {
  // The three stylesheets the shell links before steward.css: GRAIN's global
  // rules and the component bundle (components + the AI layer). variables.css
  // is tokens only, so it cannot collide.
  const sources = [
    join(config.grainDir, 'styles', 'global.css'),
    ...cssFiles(join(config.grainDir, 'components')),
    ...cssFiles(join(config.grainDir, 'ai')),
  ];
  const all = new Set<string>();
  for (const f of sources) {
    for (const c of definedClasses(await Bun.file(f).text())) all.add(c);
  }
  return all;
}

test('definedClasses reads selectors, not declarations', () => {
  const got = definedClasses(`
    /* .commented-out { } */
    .real, a.also-real > .nested { background: url(./sprite.png); content: ".not-a-class"; }
    @media (max-width: 60rem) { .in-media { gap: 1.25rem; } }
  `);
  expect([...got].sort()).toEqual(['also-real', 'in-media', 'nested', 'real']);
});

test('steward.css defines no class GRAIN already owns', async () => {
  const mine = definedClasses(await Bun.file(STEWARD_CSS).text());
  const theirs = await grainClasses();

  const collisions = [...mine]
    .filter((c) => theirs.has(c) && !ADOPTED_ANYWAY.has(c))
    .sort();

  expect(collisions).toEqual([]);
});

test('the guard would catch a new collision', async () => {
  const theirs = await grainClasses();
  // Any GRAIN class will do; pick one deterministically so the test says which.
  const victim = [...theirs].sort()[0]!;
  const mine = definedClasses(`.${victim} { color: red; }`);
  expect([...mine].filter((c) => theirs.has(c))).toEqual([victim]);
});
