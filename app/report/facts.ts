// The facts a bug report carries, and the ones it must never (0015).
//
// A report that says "it didn't work" costs more than it returns. One that carries the
// version, the platform, what was connected and the last few kilobytes of the log can
// often be answered without a second exchange.
//
// Every fact here has a reader in mind, and every one that was LEFT OUT was left out on
// purpose — see the block comment above `FACTS EXCLUDED` at the foot of this file. The
// redactor is a second line of defence, not the first: this module is expected never to
// hand it a secret in the first place.

import { basename } from 'node:path';

/** One line of the diagnostics block: a label, and something true beside it. */
export interface Fact { label: string; value: string }

export interface GoogleFacts { configured: boolean; connected: boolean }
export interface MirrorFacts { configured: boolean; connected: boolean; hasMirror: boolean }
/** Everything about the digest that is a SHAPE rather than an address or a secret. */
export interface DigestFacts {
  enabled: boolean;
  time: string;
  port: number;
  hasHost: boolean;
  hasUser: boolean;
  hasRecipient: boolean;
  hasPassword: boolean;
  lastSentOn: string;
}

export interface FactsInput {
  version: string;
  packaged: boolean;
  platform: string;
  arch: string;
  osRelease: string;
  bunVersion: string;
  uptimeSeconds: number;
  /** Whether `STEWARD_DATA` is set — the fact. Never its value. */
  dataDirOverridden: boolean;
  google: GoogleFacts;
  mirror: MirrorFacts;
  digest: DigestFacts;
  /** The absolute path `resolveChrome()` found, or null. Only its basename is printed. */
  chromePath: string | null;
  counts: { clients: number; customers: number; tickets: number; documents: number };
  /** The referring path, already normalised by `normaliseScreen`. */
  screen: string;
  log: { available: boolean; hasOld: boolean };
}

/**
 * The shape of the data directory, unexpanded.
 *
 * `dataDir()` resolves to `~/Library/Application Support/STEWARD`, `%LOCALAPPDATA%\STEWARD`
 * or `~/.local/share/steward` — and expanded, every one of those contains the operator's
 * account name. The path also tells the reader nothing an issue can act on, because it is
 * entirely determined by the platform. So print the shape.
 *
 * When `STEWARD_DATA` is set, say that it is set and nothing more: an override is a
 * diagnostic, but the path is somebody's directory layout.
 */
export function dataDirShape(platform: string, packaged: boolean, overridden: boolean): string {
  if (overridden) return 'STEWARD_DATA is set';
  if (!packaged) return "the checkout's own data/";
  if (platform === 'win32') return '%LOCALAPPDATA%\\STEWARD';
  if (platform === 'darwin') return '~/Library/Application Support/STEWARD';
  return '~/.local/share/steward';
}

/**
 * A PDF engine, named but not located.
 *
 * `resolveChrome()` searches `LOCALAPPDATA` and `PROGRAMFILES`, so the Windows answer is
 * routinely `C:\Users\<name>\AppData\Local\…`. Which browser it found is the whole
 * diagnostic value; where it lives is the operator's disk.
 */
export function chromeLabel(path: string | null): string {
  if (!path) return 'none found — PDFs will not render';
  // `basename` splits on the host's separator, and a Windows path read on a mac (a
  // fixture, or a report pasted from elsewhere) would come back whole.
  return path.split(/[\\/]/).pop() || basename(path);
}

/** Opaque ids are `prefix_` + sixteen hex characters (`app/ids.ts`). */
const OPAQUE_ID = /\/[a-z]+_[0-9a-f]{16}(?=\/|$)/g;
/** Human-facing ticket codes: `TX` + a four-letter customer code + four digits. */
const TICKET_CODE = /\/TX[A-Z]{4}\d{4}(?=\/|$)/g;

/**
 * Which surface the operator left, with the record filed off.
 *
 * `/tickets/tkt_def42d05e31c45f7` becomes `/tickets/:id`. Which ticket it was is the
 * operator's business, and no reader of a public issue could look it up anyway. The query
 * string goes too — `?from=` is ours, but a filter term is not.
 */
export function normaliseScreen(raw: string | null | undefined): string {
  if (!raw) return 'unknown';
  let path = raw.trim();
  if (!path) return 'unknown';
  // A `Referer` is an absolute URL; an explicit `?from=` is already a path.
  try { path = new URL(path).pathname; } catch { path = path.split('?')[0] ?? path; }
  if (!path.startsWith('/')) return 'unknown';
  return path.replace(OPAQUE_ID, '/:id').replace(TICKET_CODE, '/:id') || '/';
}

/** `3m 12s`, `6h 02m` — enough to tell a launch failure from a long afternoon. */
export function uptimeLabel(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

const googleLabel = (g: GoogleFacts): string =>
  !g.configured ? 'not configured' : g.connected ? 'connected' : 'configured, not connected';

const mirrorLabel = (m: MirrorFacts): string =>
  !m.configured ? 'not configured'
    : !m.connected ? 'no Google account connected'
      : m.hasMirror ? 'a mirror exists' : 'connected, no mirror created';

const digestLabel = (d: DigestFacts): string => {
  const parts = [
    d.hasHost ? 'host set' : 'no host',
    d.hasUser ? 'user set' : 'no user',
    d.hasPassword ? 'password stored' : 'no password',
    d.hasRecipient ? 'recipient set' : 'no recipient',
    `port ${d.port}`,
  ];
  const schedule = d.enabled ? `scheduled ${d.time} daily` : 'schedule off';
  const last = d.lastSentOn ? `; last sent ${d.lastSentOn}` : '';
  return `${schedule} (${parts.join(', ')})${last}`;
};

/** The diagnostics block, in the order a triager reads it. */
export function facts(input: FactsInput): Fact[] {
  const c = input.counts;
  return [
    { label: 'STEWARD', value: `${input.version} (${input.packaged ? 'packaged binary' : 'checkout'})` },
    { label: 'Platform', value: `${input.platform} ${input.arch}, release ${input.osRelease}` },
    { label: 'Bun', value: input.bunVersion },
    { label: 'Uptime', value: uptimeLabel(input.uptimeSeconds) },
    { label: 'Data directory', value: dataDirShape(input.platform, input.packaged, input.dataDirOverridden) },
    { label: 'Google', value: googleLabel(input.google) },
    { label: 'Sheets mirror', value: mirrorLabel(input.mirror) },
    { label: 'Daily digest', value: digestLabel(input.digest) },
    { label: 'PDF engine', value: chromeLabel(input.chromePath) },
    {
      label: 'Records',
      value: `${c.clients} clients, ${c.customers} customers, ${c.tickets} tickets, ${c.documents} documents`,
    },
    { label: 'Screen', value: input.screen },
    {
      label: 'Log file',
      value: input.log.available
        ? `present${input.log.hasOld ? ', plus one older generation' : ''}`
        : 'none on this build',
    },
  ];
}

/** The block as text, labels padded so the values line up in a fenced block. */
export function factLines(list: Fact[]): string {
  const width = list.reduce((w, f) => Math.max(w, f.label.length), 0);
  return list.map((f) => `${f.label.padEnd(width)}  ${f.value}`).join('\n');
}

// ---- FACTS EXCLUDED, and why ------------------------------------------------------
//
// The connected Google account. `googleAuth.status()` returns it and Settings renders it,
// correctly — that page is for the one person sitting in front of it. A public issue is
// the opposite audience. The report carries the two booleans and drops the third.
//
// The Sheets mirror URL. It points at a live spreadsheet of every client, customer and
// ticket in the business. Even behind Drive permissions, publishing the link tells the
// world both that the document exists and where to ask for access. "A mirror exists" is
// the whole diagnostic value of it.
//
// The SMTP host, username, recipient and password. The password is obvious; the other
// three are addresses that identify a business and a person. A mail bug is diagnosable
// from "host set, user set, password stored, port 465".
//
// The digest's last RESULT, which would be a useful sentence and cannot be one: it is a
// `settings` value, so the redactor's table sweep replaces it wholesale a moment later.
// A line that always reads `<redacted>` is worse than no line.
//
// The absolute data directory, the Chrome path, and any record id — see `dataDirShape`,
// `chromeLabel` and `normaliseScreen` above.
