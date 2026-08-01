// Where STEWARD keeps things that outlive a process, and how it knows which kind of
// STEWARD it is (0009).
//
// A repository checkout and a downloaded .exe want opposite answers. In a checkout the
// database belongs beside the source, where `bun run seed:demo` and a `git status` can
// both see it. In a shipped binary it must NOT: the exe gets moved, double-clicked from
// a Downloads folder, replaced wholesale by an update — and anything written next to it
// is data the operator loses the first time any of that happens.
//
// So there is exactly one switch, `PACKAGED`, and it is baked in at build time by
// `scripts/build.ts` rather than sniffed at runtime. Sniffing `import.meta.dir` for
// Bun's `/$bunfs` prefix would also work and is worse: it is an implementation detail of
// the embedder, and it cannot be set from a test.

import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** True only in a `bun build --compile` artifact. `--define`d; not overridable by env. */
export const PACKAGED = process.env.STEWARD_PACKAGED === 'true';

/**
 * The version this binary reports and, in `app/update.ts`, compares against the latest
 * GitHub release. `dev` when running from source — a checkout has a git history to
 * answer the question, and should never claim to be a release.
 */
export const VERSION = process.env.STEWARD_VERSION ?? 'dev';

/** Repo root when running from source. Meaningless (and unused) inside the binary. */
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The directory holding the database, the local document store, and the operator's
 * `steward.env`. `STEWARD_DATA` overrides everything, which is what the tests use.
 *
 * Unpackaged this is the repo's own `data/` — unchanged from every release before 0009,
 * except that it is now absolute, so running the server from a subdirectory finds the
 * real data instead of quietly creating a second empty database.
 */
export function dataDir(): string {
  const override = process.env.STEWARD_DATA;
  if (override) return override;
  if (!PACKAGED) return join(REPO_ROOT, 'data');

  if (process.platform === 'win32') {
    // LOCALAPPDATA, not APPDATA: this is machine-local state, not something that should
    // follow a roaming profile between machines — a SQLite file with a WAL beside it is
    // exactly what roaming profiles corrupt.
    const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(base, 'STEWARD');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'STEWARD');
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'steward');
}

/** Where document BYTES land when no Drive account is connected. */
export const documentsDir = (): string => join(dataDir(), 'documents');

/**
 * The operator's own settings file, read at boot in packaged mode.
 *
 * A compiled binary DOES read `.env` — but from the current working directory, which is
 * the exe's folder when Explorer launches it and something else entirely the moment
 * anyone makes a shortcut. Config that moves depending on how the app was started is not
 * config. This file sits in the data directory, which does not move.
 */
export const envFile = (): string => join(dataDir(), 'steward.env');

/**
 * Merge `steward.env` into the process environment, without overwriting anything already
 * set — a real environment variable is a deliberate act and outranks a file.
 *
 * Deliberately tiny: `KEY=value`, `#` comments, one optional layer of surrounding quotes.
 * No interpolation, no multiline, no `export`. A config format with a syntax has a syntax
 * to get wrong, and everything here is a URL, a token or a path.
 */
export function loadEnvFile(text: string, env: Record<string, string | undefined>): string[] {
  const applied: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (env[key] !== undefined) continue;
    const value = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    env[key] = value;
    applied.push(key);
  }
  return applied;
}

/**
 * What was said before the log file could exist.
 *
 * This module's body runs before anything can install a console mirror (that is the
 * point of it running early), so the lines it emits would otherwise never reach
 * `steward.log` — and they are precisely the lines someone diagnosing a launch with no
 * console window wants. `app/log.ts` flushes these first.
 */
export const bootNotes: string[] = [];

// An import-time side effect, deliberately, and this is the one place that earns it:
// `config.ts` reads `Bun.env` while ITS module body evaluates, and it imports this file,
// so this is the last moment at which anything can still be put into the environment. Do
// it from `server.ts` instead and every value has already been read.
//
// Packaged only. A checkout has `.env`, which Bun loads itself.
if (PACKAGED) {
  try {
    const applied = loadEnvFile(readFileSync(envFile(), 'utf8'), process.env);
    if (applied.length) {
      const note = `[config] ${envFile()}: ${applied.join(', ')}`;
      bootNotes.push(note);
      console.log(note);
    }
  } catch {
    // No file is the normal case on a first run. Everything here has a default, and the
    // things that do not (Google credentials) are baked in at build time.
  }
}
