// Composition-root configuration. Resolves GRAIN's package root so its
// components, styles, scripts and fonts are served without copying anything.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { documentsDir, PACKAGED, VERSION } from './app/paths.ts';

const isDev = (Bun.env.NODE_ENV ?? 'development') !== 'production';
const HERE = dirname(fileURLToPath(import.meta.url));

// GRAIN's package root — the source directory every asset is COPIED FROM at build time
// (scripts/gen-assets.ts), not read from at runtime once packaged.
//
// `import.meta.resolve` throws inside a compiled binary ("Cannot find module … from
// /$bunfs/root"), and it throws at import time, so an unguarded call here takes the whole
// app down before `main()` is reached. In a binary there is no node_modules and nothing
// asks for these paths — every byte they used to point at is embedded — so the honest
// value is the empty string: an obviously wrong path that fails loudly if it is ever
// actually used, rather than a plausible one that silently reads the wrong file.
const GRAIN = PACKAGED ? '' : dirname(fileURLToPath(import.meta.resolve('@tjakoen/grain/PLAN.md')));

// Build-time constants, substituted by `scripts/build.ts` via --define and left as the
// empty string in a checkout (where .env supplies them). Written as `process.env.X` reads
// rather than bare globals on purpose: --define replaces the whole expression in a build,
// and in dev it is just an undefined property — no ReferenceError, no shim, no .d.ts.
const BUILD_GOOGLE_CLIENT_ID = process.env.BUILD_GOOGLE_CLIENT_ID ?? '';
const BUILD_GOOGLE_CLIENT_SECRET = process.env.BUILD_GOOGLE_CLIENT_SECRET ?? '';
const BUILD_GOOGLE_API_KEY = process.env.BUILD_GOOGLE_API_KEY ?? '';
const BUILD_GOOGLE_PROJECT_NUMBER = process.env.BUILD_GOOGLE_PROJECT_NUMBER ?? '';

export const config = {
  isDev,
  /** True only in a `bun build --compile` artifact. */
  packaged: PACKAGED,
  /** What this build calls itself; `dev` from a checkout. */
  version: VERSION,
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
  docsDir: documentsDir(),
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
  //
  // Which is why a release binary BAKES them in (`scripts/build.ts` --define, values from
  // CI secrets so they never enter the tree). The alternative — a hand-placed file — means
  // a freshly downloaded exe has no Drive until someone edits config, and that is not a
  // shipped product. Env still wins over the baked value, so a different registration
  // needs no rebuild; and a build with no secrets configured yields a working binary with
  // Drive switched off, not a broken one.
  google: {
    clientId: Bun.env.GOOGLE_CLIENT_ID ?? BUILD_GOOGLE_CLIENT_ID,
    clientSecret: Bun.env.GOOGLE_CLIENT_SECRET ?? BUILD_GOOGLE_CLIENT_SECRET,
    /** Must match a redirect URI registered on the OAuth client. */
    redirectPath: '/oauth/google/callback',
    // The Google Picker — the only way to link a file STEWARD did not create —
    // needs two things the OAuth client does not carry: a browser API key, and
    // the Cloud project NUMBER. The number is what tells Drive which app to
    // grant per-file access to when the operator picks something; without it a
    // pick under `drive.file` yields a file we still cannot read.
    apiKey: Bun.env.GOOGLE_API_KEY ?? BUILD_GOOGLE_API_KEY,
    projectNumber: Bun.env.GOOGLE_PROJECT_NUMBER ?? BUILD_GOOGLE_PROJECT_NUMBER,
    /** Folder created in the operator's own Drive to hold STEWARD's files. */
    folderName: Bun.env.GOOGLE_DRIVE_FOLDER ?? 'STEWARD',
  },
} as const;
