// Composition-root configuration. Resolves GRAIN's package root so its
// components, styles, scripts and fonts are served without copying anything.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const isDev = (Bun.env.NODE_ENV ?? 'development') !== 'production';
const HERE = dirname(fileURLToPath(import.meta.url));
const GRAIN = dirname(fileURLToPath(import.meta.resolve('@tjakoen/grain/PLAN.md')));

export const config = {
  isDev,
  // A malformed PORT (e.g. a whole shell command pasted into .env) must not
  // become NaN and silently strand the server on a random port.
  port: Number.isFinite(Number(Bun.env.PORT)) && Number(Bun.env.PORT) > 0
    ? Number(Bun.env.PORT)
    : 3000,
  root: HERE,
  grainDir: GRAIN,

  // GRAIN atoms/molecules/organisms first, then STEWARD's own components.
  componentRoots: [join(GRAIN, 'components'), join(HERE, 'frontend', 'components')],
  styleRoots: [join(GRAIN, 'components'), join(HERE, 'frontend', 'components'), join(GRAIN, 'ai')],

  pagesDir: join(HERE, 'frontend', 'pages'),
  /** Local document store root (used until a Drive account is connected). */
  docsDir: join(HERE, 'data', 'documents'),
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

  // Google OAuth (installed-app flow). The client id/secret identify the APP,
  // not the operator — one registration serves every install, and each person
  // signs in with their own account. Desktop client secrets are not truly
  // secret (Google says so); PKCE is what protects the exchange.
  google: {
    clientId: Bun.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: Bun.env.GOOGLE_CLIENT_SECRET ?? '',
    /** Must match a redirect URI registered on the OAuth client. */
    redirectPath: '/oauth/google/callback',
    // The Google Picker — the only way to link a file STEWARD did not create —
    // needs two things the OAuth client does not carry: a browser API key, and
    // the Cloud project NUMBER. The number is what tells Drive which app to
    // grant per-file access to when the operator picks something; without it a
    // pick under `drive.file` yields a file we still cannot read.
    apiKey: Bun.env.GOOGLE_API_KEY ?? '',
    projectNumber: Bun.env.GOOGLE_PROJECT_NUMBER ?? '',
    /** Folder created in the operator's own Drive to hold STEWARD's files. */
    folderName: Bun.env.GOOGLE_DRIVE_FOLDER ?? 'STEWARD',
  },
} as const;
