// Composition-root configuration. Resolves GRAIN's package root so its
// components, styles, scripts and fonts are served without copying anything.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const isDev = (Bun.env.NODE_ENV ?? 'development') !== 'production';
const HERE = dirname(fileURLToPath(import.meta.url));
const GRAIN = dirname(fileURLToPath(import.meta.resolve('@tjakoen/grain/PLAN.md')));

export const config = {
  isDev,
  port: Number(Bun.env.PORT ?? 3000),
  root: HERE,
  grainDir: GRAIN,

  // GRAIN atoms/molecules/organisms first, then STEWARD's own components.
  componentRoots: [join(GRAIN, 'components'), join(HERE, 'frontend', 'components')],
  styleRoots: [join(GRAIN, 'components'), join(HERE, 'frontend', 'components'), join(GRAIN, 'ai')],

  pagesDir: join(HERE, 'frontend', 'pages'),
  plansDir: join(HERE, 'plans'),
  toursDir: join(HERE, 'tours'),
  contentDir: join(HERE, 'content'),

  assetDirs: {
    '/styles': join(GRAIN, 'styles'),
    '/scripts': join(GRAIN, 'scripts'),
    '/assets': join(GRAIN, 'assets'),
    '/app': join(HERE, 'frontend', 'client'), // STEWARD client-side modules
  } as Record<string, string>,

  fontsDir: join(GRAIN, 'fonts'),
  missingBindings: (isDev ? 'warn' : 'ignore') as 'ignore' | 'warn' | 'throw',

  // Consumer-declared theme flavors (list[0] = default → the hueless Sourdough
  // :root, selected by dropping the attribute). GRAIN hardcodes none.
  themes: 'sourdough baguette brioche',
} as const;
