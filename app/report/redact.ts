// The last thing that happens to a bug report before anyone sees it (0015).
//
// The body goes to a PUBLIC repository, under the operator's own GitHub identity, and it
// carries a slab of `steward.log` — arbitrary text, written by code nobody is reviewing at
// report time, which will grow new lines in every plan after this one. An allowlist of
// things to scrub is out of date the day it is written.
//
// So this is a rule, not a list. Four sweeps, applied to the WHOLE body — diagnostics and
// log alike — as the last step before the text reaches the textarea.
//
// Two things it deliberately does not do. It does not touch client or customer names,
// because it cannot: a client called "Northern" would turn every occurrence of that word
// into a placeholder, including in the error message where it is the actual clue
// (`app/mail/digest.ts` logs `could not render <client name>`). And it does not touch free
// text the operator typed themselves — they typed it, they can see it, it is theirs. The
// answer to both is the textarea, not a regex.

/**
 * The floor under the settings sweep.
 *
 * `settings` also holds `1`, `0`, `465` and `08:00`. Scrubbing those would turn the log
 * into placeholder soup, so a value has to be at least this long to be worth hiding —
 * and nothing that is actually a secret is shorter.
 */
export const MIN_SECRET_LENGTH = 8;

export const REDACTED = '<redacted>';
export const EMAIL_MARK = '<email>';

export interface RedactionSources {
  /**
   * Every value currently in the `settings` table (`SettingsRepository.keys()` + `get`).
   * Nulls and short values are ignored here rather than at the call site.
   */
  secrets?: readonly (string | null | undefined)[];
  /** `os.homedir()`. Injected so a test can assert on a path this machine does not have. */
  home?: string | null;
}

/**
 * Values that are shaped like a date, a time, a duration or a number, and are therefore
 * not secrets whatever their length.
 *
 * `digest.last_sent_on` is a ten-character ISO date and lives in `settings` — sweeping it
 * would rewrite the leading date of every line in the log, which is precisely the
 * "timestamps into nonsense" outcome the eight-character floor exists to avoid. The floor
 * alone does not catch it, so this does.
 */
const NOT_A_SECRET = /^\d[\d\s.:T/-]*Z?$/;

/** Token shapes, caught even when the credential was never stored. */
const TOKEN_PATTERNS: [RegExp, string][] = [
  // Google access tokens, and the refresh tokens Google hands an installed app.
  [/ya29\.[A-Za-z0-9._~+/-]+=*/g, REDACTED],
  [/(^|[\s"'=:])1\/\/[A-Za-z0-9._~+/-]{10,}=*/g, `$1${REDACTED}`],
  // Anything presented as a credential, whoever issued it.
  [/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, `Bearer ${REDACTED}`],
  // A credential in flight through a URL — the case an error message is most likely to
  // contain, and the one rule 3 cannot catch because it was never stored.
  [
    /([?&](?:code|state|access_token|refresh_token|id_token|client_secret)=)[^&\s"'<>]+/g,
    `$1${REDACTED}`,
  ],
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** Literal replacement — no regex, so a `.` or a `\` in a secret cannot become a wildcard. */
const swap = (text: string, needle: string, replacement: string): string =>
  needle ? text.split(needle).join(replacement) : text;

/**
 * The forms a home directory takes in text this app produces: as `os.homedir()` gives it,
 * with the other platform's separator, and JSON-escaped (which is how it arrives inside a
 * `Bun.inspect`ed object, and stack traces from a checkout are full of them).
 */
export function homeVariants(home: string): string[] {
  // `/` on its own would rewrite every path in the file. A home directory that short is
  // not a home directory.
  if (home.length < 4) return [];
  const forward = home.replace(/\\/g, '/');
  const back = home.replace(/\//g, '\\');
  return [...new Set([home, forward, back, back.replace(/\\/g, '\\\\')])]
    .sort((a, b) => b.length - a.length);
}

/** True when this settings value is worth hiding: long enough, and not a date or a number. */
export function isSweepable(value: string | null | undefined): value is string {
  return typeof value === 'string'
    && value.length >= MIN_SECRET_LENGTH
    && !NOT_A_SECRET.test(value);
}

/**
 * Scrub a body.
 *
 * Order is deliberate. The two LITERAL sweeps run first: once an email inside a stored
 * value has become `<email>`, that value no longer matches itself, and the sweep that
 * would have caught the whole string silently misses. Patterns rewrite, literals match —
 * so literals go first, longest first, and the patterns clean up what is left.
 */
export function redact(text: string, sources: RedactionSources = {}): string {
  let out = text;

  // 1. Everything in the settings table. Longest first, so a value that contains another
  //    value is not left half-scrubbed by its own substring.
  const secrets = (sources.secrets ?? [])
    .filter(isSweepable)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) out = swap(out, secret, REDACTED);

  // 2. Token shapes — the belt to rule 1's braces.
  for (const [pattern, replacement] of TOKEN_PATTERNS) out = out.replace(pattern, replacement);

  // 3. The home directory. The highest-yield single substitution there is: it catches the
  //    data directory, the documents directory, the Chrome path, every stack frame from a
  //    checkout, and the operator's account name inside all of them.
  if (sources.home) for (const variant of homeVariants(sources.home)) out = swap(out, variant, '~');

  // 4. Email addresses. Last, because a home directory can contain one on a domain-joined
  //    machine (`/Users/jo.smith@corp`) and rewriting that first would cost us the `~`.
  return out.replace(EMAIL, EMAIL_MARK);
}
