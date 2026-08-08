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

  // Google OAuth (installed-app flow), minus every credential.
  //
  // **The four secret-shaped values are NOT here, and must not come back** (0017). They
  // live in `settings` and are read through `app/google/credentials.ts`, for two reasons
  // that this object cannot satisfy:
  //
  //   - It is frozen at boot. The operator pastes credentials into a RUNNING app and
  //     expects Connect Google Drive to work without a restart.
  //   - A value in `config` is not a value in `settings`, and 0015's bug-report redaction
  //     sweeps `settings`. Baked credentials were never covered by it.
  //
  // What remains here is the part that is neither secret nor operator-specific.
  google: {
    /** Must match a redirect URI registered on the OAuth client. */
    redirectPath: '/oauth/google/callback',
    /** Folder created in the operator's own Drive to hold STEWARD's files. */
    folderName: Bun.env.GOOGLE_DRIVE_FOLDER ?? 'STEWARD',
  },
} as const;
