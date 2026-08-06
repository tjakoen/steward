// The markdown body, the 8 KB URL budget, and what falls off the end (0015).

import { factLines, type Fact } from './facts.ts';
import { redact, type RedactionSources } from './redact.ts';
import type { LogTail } from './tail.ts';

export const ISSUE_NEW = 'https://github.com/tjakoen/steward/issues/new';

/**
 * `bug` is one of the labels GitHub creates in every new repository. Passing a label that
 * does NOT exist makes GitHub reject the whole prefilled form, so do not invent taxonomy
 * here without creating the label first.
 */
export const LABEL = 'bug';

/**
 * A URL has a practical ceiling around 8 KB — not in the browser's address bar, which is
 * far more generous, but at the other end, where GitHub's front end caps the request line
 * and answers 414 past it. Design to 8 KB and the feature works everywhere; design to a
 * browser's limit and it works until it silently does not.
 */
export const URL_BUDGET = 8_000;

/** Long enough to say what broke; short enough to read in an issue list. */
export const TITLE_MAX = 120;

export const DROP_MARKER = '… earlier lines dropped to fit the URL';

/**
 * The operator's half, and it goes FIRST.
 *
 * Their sentence is the part a human reads; the machine's paragraph is the part they
 * scroll to afterwards. A report that opens with a diagnostics dump buries the only
 * content nobody else could have written.
 */
export const PROMPTS = [
  '### What happened',
  '',
  '',
  '### What I expected',
  '',
  '',
  '### How to reproduce it',
  '',
  '1. ',
  '2. ',
  '3. ',
  '',
].join('\n');

/**
 * `encodeURIComponent`, and nothing hand-rolled.
 *
 * Four characters break a naive build and all four occur in real log lines. A newline is
 * not legal in a URL at all. `#` truncates the body at the fragment, silently, so a log
 * line mentioning `#3` would eat everything after it. `&` starts a new query parameter,
 * so `a&b=c` in a stack trace injects a parameter into GitHub's own form. And `+` is
 * decoded as a space by most query parsers, which quietly corrupts any diff in the log.
 *
 * `encodeURI` escapes none of `#&+` — it is for whole URLs, not for components — so it is
 * the wrong function and would look right in testing.
 */
export function issueUrl(title: string, body: string): string {
  return `${ISSUE_NEW}?title=${encodeURIComponent(title.slice(0, TITLE_MAX))}` +
    `&body=${encodeURIComponent(body)}&labels=${LABEL}`;
}

/**
 * The measured size of the request GitHub would receive.
 *
 * `encodeURIComponent` output is pure ASCII, so one character is one byte and `.length`
 * IS the byte count — which is what lets the page recompute the same number in the
 * browser from the same two strings.
 */
export const urlBytes = (title: string, body: string): number => issueUrl(title, body).length;

export interface BodyInput {
  facts: Fact[];
  log: LogTail;
  /** Measured with the title, because the title is in the same URL. */
  title: string;
  redaction?: RedactionSources;
  budget?: number;
}

export interface BuiltBody {
  body: string;
  url: string;
  bytes: number;
  budget: number;
  /** How many of the oldest tail lines were left out. */
  dropped: number;
  logIncluded: boolean;
  /** True only when the diagnostics alone will not fit — nothing left to drop. */
  overBudget: boolean;
}

const fence = (text: string): string => `\`\`\`\n${text}\n\`\`\``;

const logSection = (lines: string[], dropped: number, log: LogTail): string => {
  if (!log.available) return `### Log\n\n${log.reason}\n`;
  if (!lines.length) {
    return '### Log\n\nThe log tail did not fit inside the URL, so it was left out. ' +
      'Use **Copy** or **Save to a file** on the report page to attach it by hand.\n';
  }
  const old = log.hasOld ? '\nAn older generation, `steward.log.old`, also exists on this machine.\n' : '';
  // Truncation the reader cannot see is worse than truncation: it makes a partial log
  // look like a complete one. So the marker sits inside the block, at the cut.
  const marker = dropped > 0 ? `${DROP_MARKER} (${dropped} of them)\n` : '';
  return `### Log — the tail of \`steward.log\`\n${old}\n${fence(marker + lines.join('\n'))}\n`;
};

const compose = (facts: Fact[], section: string, redaction?: RedactionSources): string =>
  // Redaction is the LAST step, and it is inside the measuring loop on purpose: replacing
  // an eight-character secret with `<redacted>` makes the body LONGER, so a budget
  // measured before it is a budget measured against the wrong string.
  redact(
    `${PROMPTS}\n---\n\n### Diagnostics\n\n` +
    'Collected automatically. Edit or delete anything below before sending.\n\n' +
    `${fence(factLines(facts))}\n\n${section}`,
    redaction,
  );

/**
 * Build the body, then make it fit.
 *
 * Do not guess the ratio between characters and encoded bytes: build it, encode it,
 * measure the string, and if it is over budget drop the OLDEST log line and measure
 * again. The newest lines are the ones next to the crash.
 */
export function buildBody(input: BodyInput): BuiltBody {
  const budget = input.budget ?? URL_BUDGET;
  const { facts, log, title, redaction } = input;
  const measure = (body: string): BuiltBody => ({
    body,
    url: issueUrl(title, body),
    bytes: urlBytes(title, body),
    budget,
    dropped: 0,
    logIncluded: false,
    overBudget: urlBytes(title, body) > budget,
  });

  const withoutLog = measure(compose(facts, logSection([], 0, log), redaction));
  // Nothing to fit, or nothing left to drop: either way this is the answer, and when it
  // is still over budget the page refuses rather than handing GitHub a 414.
  if (!log.available || withoutLog.overBudget) return withoutLog;

  const lines = log.text.split('\n');
  let best = withoutLog;
  for (let i = lines.length - 1; i >= 0; i--) {
    const kept = lines.slice(i);
    const body = compose(facts, logSection(kept, i, log), redaction);
    if (urlBytes(title, body) > budget) break;
    best = { ...measure(body), dropped: i, logIncluded: true };
  }
  return best;
}

/** `6.1 KB` — the same rendering the page recomputes on every keystroke. */
export const kb = (bytes: number): string => `${(bytes / 1000).toFixed(1)} KB`;

/** A title that says something before the operator has typed anything. */
export function defaultTitle(screen: string, version: string): string {
  const where = screen && screen !== 'unknown' ? ` on ${screen}` : '';
  return `Bug${where} (STEWARD ${version})`.slice(0, TITLE_MAX);
}
