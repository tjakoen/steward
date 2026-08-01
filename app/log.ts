// A log file in the data directory — the prerequisite for hiding the console (0010).
//
// 0009 refused `--windows-hide-console` with a specific argument: the console is the
// only feedback a first run has, and hiding it turns a failed launch into an invisible
// one. That argument is not answered by time passing. It is answered by giving a failed
// launch somewhere else to be visible, which is this file.
//
// Packaged only. From a checkout the terminal is right there, and a log file that
// shadows it is one more thing to be stale.

import { appendFileSync, renameSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGED, bootNotes, dataDir } from './paths.ts';

/** One generation is kept. An unbounded log on someone's laptop is its own bug. */
const MAX_BYTES = 1_000_000;

export const logFile = (): string => join(dataDir(), 'steward.log');

const stamp = (parts: unknown[]): string =>
  `${new Date().toISOString()} ${parts.map((p) => (typeof p === 'string' ? p : Bun.inspect(p))).join(' ')}\n`;

/**
 * Mirror the console into the log file and catch whatever kills the process.
 *
 * Returns the path, or null when there is nothing to do. Writes are synchronous:
 * ordering is the entire value of a boot log, and the volume is a handful of lines
 * a minute. Never throws — a machine where the data directory cannot be written is
 * already in trouble, and taking the app down over its logging would make that worse.
 */
export function installFileLog(force = false): string | null {
  if (!PACKAGED && !force) return null;
  const file = logFile();

  try {
    mkdirSync(dataDir(), { recursive: true });
    if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.old`);
  } catch { /* no file yet, or nowhere to put one */ }

  const write = (line: string): void => {
    try { appendFileSync(file, line); } catch { /* see above */ }
  };

  // Anything already said during module evaluation — the env-file line in paths.ts is
  // emitted before this can possibly be installed, and it is exactly the kind of line
  // someone diagnosing a bad launch wants.
  for (const note of bootNotes) write(stamp([note]));

  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...parts: unknown[]) => { write(stamp(parts)); original(...parts); };
  }

  // The failures that never reach a console.error: a throw out of top-level await, a
  // rejected promise nobody awaited. Without these, hiding the window would make a
  // crashed launch completely silent.
  process.on('uncaughtException', (err) => {
    write(stamp(['[fatal]', err.stack ?? String(err)]));
    console.error('[fatal]', err);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    write(stamp(['[fatal] unhandled rejection:', reason instanceof Error ? reason.stack ?? reason.message : String(reason)]));
    console.error('[fatal] unhandled rejection:', reason);
    process.exit(1);
  });

  return file;
}

// Installed at IMPORT time, and `server.ts` imports this module first, so every line any
// later module emits while ITS body evaluates lands in the file too. A call from the
// server's body would be too late for all of them.
if (PACKAGED) installFileLog();
