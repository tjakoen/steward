// The four Google values, held by the operator rather than by the build (0017).
//
// Until 0017 these were compiled into every published binary by `scripts/build.ts --define`.
// `tjakoen/steward` is public and so are its releases, so `strings` over a 61 MB download
// handed anyone the API key, the OAuth client id, the client secret and the project number —
// measured, not feared. With a billing account attached to the project, that is a bill.
//
// So nothing is baked any more. A downloaded STEWARD has no Google credentials at all and
// says so; the operator pastes them into Settings, and hands them to their own users out of
// band. Everything that is not Google — clients, customers, tickets, PDFs, the local
// document store, the SMTP digest — works on first launch regardless.
//
// Two properties this file exists to guarantee:
//
//   1. **Read per call, never captured.** The operator pastes credentials into a RUNNING
//      app and expects Connect Google Drive to work without a restart. `config.google` was
//      a boot-time frozen object, which is exactly the shape that cannot do that, so these
//      values left `config` entirely rather than sitting beside it.
//   2. **Stored in `settings`, which is what makes them redactable.** 0015's bug report
//      scrubs every `settings` value of 8+ characters as a sweep, so all four are covered
//      the moment they live here — and none of them was covered while it was baked, because
//      a compiled constant is not in the table.

import type { SettingsRepository } from '../repo/ports.ts';

export const CREDENTIAL_KEYS = {
  clientId: 'google.client_id',
  clientSecret: 'google.client_secret',
  apiKey: 'google.api_key',
  projectNumber: 'google.project_number',
} as const;

export type CredentialField = keyof typeof CREDENTIAL_KEYS;

/**
 * The environment variable each field falls back to.
 *
 * Env is kept as a second tier purely for the development loop: a checkout with a `.env`
 * behaves exactly as it did before 0017, so the maintainer never has to go through the
 * Settings form to work on the app. There is no third tier — the baked layer is gone.
 */
const ENV_KEYS: Record<CredentialField, string> = {
  clientId: 'GOOGLE_CLIENT_ID',
  clientSecret: 'GOOGLE_CLIENT_SECRET',
  apiKey: 'GOOGLE_API_KEY',
  projectNumber: 'GOOGLE_PROJECT_NUMBER',
};

export interface GoogleCredentials {
  /** Settings first, then env. Empty string when neither has it. */
  read(field: CredentialField): string;
  /** Every field, for the Settings card and the readiness routes. */
  all(): Record<CredentialField, string>;
  /** Fields with no value anywhere, in the order the Settings card lists them. */
  missing(): CredentialField[];
  /** Both halves of the OAuth registration are present. */
  hasOAuthClient(): boolean;
  /** Both halves of the Picker's requirement are present. */
  hasPicker(): boolean;
  write(field: CredentialField, value: string): void;
  clear(field: CredentialField): void;
}

const FIELDS: CredentialField[] = ['clientId', 'clientSecret', 'apiKey', 'projectNumber'];

/**
 * What a pasted value has to look like.
 *
 * This form invites exactly one mistake — four boxes, four opaque strings out of the same
 * Console, and nothing on screen to distinguish them once pasted. Each value is distinctive
 * enough to catch a swap at the door, which is the only place it can be caught: a client id
 * in the API key box produces "The API developer key is invalid" hours later, and 0016
 * records what diagnosing that message costs.
 *
 * Deliberately shape checks, not validity checks. Whether Google accepts a well-formed key
 * is Google's answer to give, and the app already has a place to show it.
 */
const SHAPES: Record<CredentialField, { test: (v: string) => boolean; expected: string }> = {
  clientId: {
    test: (v) => v.endsWith('.apps.googleusercontent.com'),
    expected: 'an OAuth client id, ending in .apps.googleusercontent.com',
  },
  clientSecret: {
    test: (v) => v.startsWith('GOCSPX-'),
    expected: 'a Desktop client secret, starting with GOCSPX-',
  },
  apiKey: {
    test: (v) => /^AIza[A-Za-z0-9_-]{35}$/.test(v),
    expected: 'a browser API key: AIza followed by 35 characters',
  },
  projectNumber: {
    test: (v) => /^[0-9]{6,}$/.test(v),
    expected: 'the Cloud project NUMBER — digits only, not the project id',
  },
};

/** `null` when the value is the right shape; the sentence to show when it is not. */
export function shapeComplaint(field: CredentialField, value: string): string | null {
  return SHAPES[field].test(value) ? null : `That does not look like ${SHAPES[field].expected}.`;
}

/**
 * Whitespace off a Console copy-paste.
 *
 * Not `normalisePassword` from 0013: that one un-spaces Gmail's four-block app password
 * display, which is a 16-letter-specific rule and would mangle nothing here but belongs to
 * a different problem. None of these four values may contain internal whitespace, so
 * stripping all of it is both safe and what a paste out of a browser needs.
 */
export function normaliseCredential(raw: string): string {
  return raw.replace(/\s+/g, '');
}

/**
 * @param env Injected so a test can assert the resolution order against an environment
 *   this machine does not have. The repository's own `.env` is loaded into `Bun.env` while
 *   the suite runs, so a test that did not control this would pass or fail depending on
 *   whether the developer happens to have credentials configured.
 */
/**
 * The project number, read off the client id.
 *
 * A Google OAuth client id is `<project number>-<hash>.apps.googleusercontent.com`, so the
 * number the Picker needs as its `appId` is already in a value the operator has to supply
 * anyway. Deriving it turns four things to paste into three, and removes the one field
 * whose name invites the wrong answer — Console shows a project *id* (`steward-app-42`)
 * far more prominently than the number.
 *
 * Returns `''` when the id is not that shape, so the stored field stays authoritative and
 * a project where this does not hold can still be configured by hand.
 */
export function projectNumberFrom(clientId: string): string {
  const head = clientId.split('-')[0] ?? '';
  return /^[0-9]{6,}$/.test(head) && clientId.endsWith('.apps.googleusercontent.com') ? head : '';
}

export interface ParsedBlob {
  values: Partial<Record<CredentialField, string>>;
  /** What could not be used, in words, so the card can say why nothing happened. */
  complaints: string[];
}

/**
 * Read credentials out of pasted or uploaded text.
 *
 * Accepts **Google's own `client_secret_*.json` download** — the file Console hands you when
 * you create the OAuth client — because inventing a format the operator has to build by hand
 * when a canonical one already exists is work for no reason. Desktop clients nest under
 * `installed`, web clients under `web`; both are read.
 *
 * Also accepts a flat STEWARD blob, which is what `export` produces, because Google's file
 * cannot carry the API key — no Console download contains one.
 *
 * Nothing here writes: the caller still runs every value through `shapeComplaint`, so the
 * file path cannot smuggle in a value the typed fields would have refused.
 */
export function parseCredentialBlob(text: string): ParsedBlob {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { values: {}, complaints: ['That is not valid JSON.'] };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { values: {}, complaints: ['That JSON is not an object.'] };
  }

  const root = parsed as Record<string, unknown>;
  const nested = (root.installed ?? root.web) as Record<string, unknown> | undefined;
  const source = nested && typeof nested === 'object' ? nested : root;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');

  // Google's snake_case first, then STEWARD's own camelCase.
  const values: Partial<Record<CredentialField, string>> = {};
  const clientId = str(source.client_id) || str(root.clientId);
  const clientSecret = str(source.client_secret) || str(root.clientSecret);
  const apiKey = str(root.api_key) || str(root.apiKey);
  const projectNumber = str(root.project_number) || str(root.projectNumber);

  if (clientId) values.clientId = clientId;
  if (clientSecret) values.clientSecret = clientSecret;
  if (apiKey) values.apiKey = apiKey;
  // Explicit wins; otherwise derive, which is what makes Google's own file sufficient for
  // three of the four fields.
  const derived = projectNumber || projectNumberFrom(clientId);
  if (derived) values.projectNumber = derived;

  const complaints: string[] = [];
  if (!Object.keys(values).length) {
    complaints.push('No credentials found in that file. Expected a client_secret JSON from Google, or an export from STEWARD.');
  } else if (!apiKey) {
    // Not a failure — Google's download genuinely has no key in it — but silence here
    // leaves the operator thinking they are finished when Link from Drive will not work.
    complaints.push('No API key in that file: Google does not put one in it. Add it below if you want Link from Drive.');
  }
  return { values, complaints };
}

export function makeCredentials(
  settings: SettingsRepository,
  env: Record<string, string | undefined> = Bun.env,
): GoogleCredentials {
  const read = (field: CredentialField): string =>
    settings.get(CREDENTIAL_KEYS[field]) ?? env[ENV_KEYS[field]] ?? '';

  const all = (): Record<CredentialField, string> =>
    Object.fromEntries(FIELDS.map((f) => [f, read(f)])) as Record<CredentialField, string>;

  return {
    read,
    all,
    missing: () => FIELDS.filter((f) => !read(f)),
    hasOAuthClient: () => Boolean(read('clientId') && read('clientSecret')),
    hasPicker: () => Boolean(read('apiKey') && read('projectNumber')),
    write: (field, value) => settings.set(CREDENTIAL_KEYS[field], value),
    clear: (field) => settings.remove(CREDENTIAL_KEYS[field]),
  };
}
