// Shared renderer: expands GRAIN <b-*> component tags in pages/fragments.

import { readFileSync } from 'node:fs';
import { createRenderer } from '@tjakoen/batch/render/render.ts';
import { COMPONENTS } from './build/assets.gen.ts';
import { config } from './config.ts';
import { PACKAGED } from './app/paths.ts';

/**
 * Two ways in, and the honest one for each.
 *
 * From a checkout: the source roots, walked by the renderer, so `bun --hot` still picks up
 * an edited template. Packaged: the embedded templates handed over directly — BATCH 0.2.0
 * takes a `templates` map, which is what 0009 said the fix was and 0010 upstreamed. Before
 * it existed, the binary had to write ten files into the data directory at boot just to
 * give a directory walk something to find.
 *
 * `readFileSync` on an embedded `/$bunfs` path works, and it has to be synchronous:
 * `createRenderer` is constructed while this module's body evaluates.
 */
const templates = (): Record<string, string> => Object.fromEntries(
  Object.entries(COMPONENTS).map(([file, embedded]) => [
    file.replace(/\.html$/, ''), readFileSync(embedded, 'utf8'),
  ]),
);

export const { render, renderPage, refresh } = createRenderer({
  // `config` is `as const`, so the roots arrive as a readonly tuple; the option is a
  // plain array.
  ...(PACKAGED ? { templates: templates() } : { componentsDir: [...config.componentRoots] }),
  missing: config.missingBindings,
});
