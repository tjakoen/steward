// Component templates for BATCH's `<b-*>` renderer, in a binary (0009).
//
// Every other embedded file is READ by path, and an embedded path reads fine. This one is
// different: `createRenderer` builds its registry with its own `readdirSync` over the
// directories it is handed, and there is no seam to hand it a registry instead. A walk
// cannot enumerate Bun's embedded filesystem, and the walk runs at startup — which is how
// the first binary died, on `ENOENT: no such file or directory, scandir 'components'`,
// before it bound a port.
//
// So the templates are written out once, at boot, into the data directory, and the
// renderer is pointed at a directory that genuinely exists. That is a workaround for a
// missing injection point upstream, and it is written down as one rather than dressed up:
// the honest fix is a `templates` option on `createRenderer`, which is a BATCH change and
// a publish cycle, and belongs in whichever plan next touches BATCH.
//
// Leaving them out was the tempting alternative and is the trap. An empty registry does
// not error — `<b-button>` would pass straight through to the browser as an unknown
// element. Working in a checkout and silently rendering nothing in the binary is exactly
// the divergence this whole task exists to prevent.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMPONENTS } from '../../build/assets.gen.ts';
import { PACKAGED, dataDir } from '../paths.ts';

/**
 * The directories `createRenderer` should walk.
 *
 * From a checkout: the source roots, untouched — nothing is written, and `bun --hot`
 * still picks up an edited template. Packaged: one materialised directory.
 */
export function componentRoots(sourceRoots: readonly string[]): string[] {
  if (!PACKAGED) return [...sourceRoots];

  const dir = join(dataDir(), 'components');
  mkdirSync(dir, { recursive: true });
  for (const [name, embedded] of Object.entries(COMPONENTS)) {
    // Rewritten on every boot on purpose: an update replaces the binary and its embedded
    // templates, and a stale copy from the previous version sitting in the data directory
    // would quietly win. Ten small files; not worth a freshness check to skip.
    // `readFileSync` on an embedded path works — verified, and the reason this can be
    // synchronous at all. `createRenderer` is constructed at import time in render.ts, so
    // there is no await available here.
    writeFileSync(join(dir, name), readFileSync(embedded, 'utf8'));
  }
  return [dir];
}
