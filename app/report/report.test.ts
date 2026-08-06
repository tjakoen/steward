// The gate for 0015. `tsc` cannot see a redaction failure and it cannot see a 414.
//
// Two of these tests are the whole reason the feature is allowed to exist: the body goes
// to a PUBLIC repository, so "no secret survives" has to be executed rather than asserted
// in a comment — and it is asserted by the ABSENCE OF THE ACTUAL VALUES, never by the
// presence of the word `<redacted>`. A redactor that passes by deleting everything is not
// a redactor, so the ordinary lines around the secrets are asserted too.

import { test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { setDb } from '../repo/db.ts';
import { sqliteRepositories } from '../repo/sqlite.ts';
import type { Repositories } from '../repo/ports.ts';
import { buildReport } from './index.ts';
import { buildBody, DROP_MARKER, issueUrl, URL_BUDGET } from './body.ts';
import { chromeLabel, dataDirShape, facts, normaliseScreen, uptimeLabel } from './facts.ts';
import { isSweepable, redact } from './redact.ts';
import { readLogTail, TAIL_BYTES } from './tail.ts';
import { reportPage } from '../view/report.ts';

const HOME = homedir();

// ---- fixtures ---------------------------------------------------------------------

/** Secrets a real install holds, in the keys it really holds them under. */
const SECRETS = {
  refresh: '1//04xyzREFRESHTOKENfromTheSettingsTable',
  account: 'operator@example.com',
  password: 'abcdefghijklmnop',
  mirror: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit',
  host: 'smtp.gmail.com',
  to: 'bookkeeper@northernroofing.example',
  access: 'ya29.a0AfB_byExampleAccessTokenValue',
  code: '4/0AeanS0bSECRETAUTHORIZATIONCODE',
  state: 'sTaTeNoNcE1234567890',
};

const seedSecrets = (repos: Repositories): void => {
  repos.settings.set('google.refresh_token', SECRETS.refresh);
  repos.settings.set('google.access_token', SECRETS.access);
  repos.settings.set('google.account', SECRETS.account);
  repos.settings.set('digest.smtp_password', SECRETS.password);
  repos.settings.set('digest.smtp_host', SECRETS.host);
  repos.settings.set('digest.to', SECRETS.to);
  repos.settings.set('sheets.spreadsheet_url', SECRETS.mirror);
  repos.settings.set('sheets.spreadsheet_id', '1AbCdEfGhIjKlMnOpQrStUvWxYz');
  repos.settings.set('digest.enabled', '1');
  repos.settings.set('digest.smtp_port', '465');
  repos.settings.set('digest.time', '08:00');
  // A ten-character value in `settings` that is also the leading date of every log line.
  repos.settings.set('digest.last_sent_on', '2026-08-06');
};

/** A log with all five of the things that must not survive, and ordinary lines around them. */
const FIXTURE_LOG = [
  '2026-08-06T09:00:01.000Z [server] STEWARD dev → http://localhost:3214',
  '2026-08-06T09:00:02.000Z [digest] could not render Northern Roofing: no template',
  `2026-08-06T09:00:03.000Z [google] Authorization: Bearer ${SECRETS.access}`,
  '2026-08-06T09:00:04.000Z [oauth] callback ' +
    `http://127.0.0.1:3211/oauth/google/callback?code=${SECRETS.code}&state=${SECRETS.state}`,
  `2026-08-06T09:00:05.000Z [mail] sending to ${SECRETS.to}`,
  `2026-08-06T09:00:06.000Z [fatal] Error: ENOENT ${HOME}/Library/Application Support/STEWARD/steward.db`,
  `2026-08-06T09:00:07.000Z [sheets] token ${SECRETS.refresh} rejected; mirror ${SECRETS.mirror}`,
  `2026-08-06T09:00:08.000Z [mail] 535 for user with ${SECRETS.password}`,
  '2026-08-06T09:00:09.000Z [server] ready',
].join('\n');

const tempLog = (text: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'steward-report-'));
  const file = join(dir, 'steward.log');
  writeFileSync(file, text);
  return file;
};

const fresh = (): Repositories => {
  setDb(new Database(':memory:'));
  return sqliteRepositories();
};

const CONNECTED = {
  google: { configured: true, connected: true },
  mirror: { configured: true, connected: true, url: SECRETS.mirror },
};

beforeEach(() => { setDb(new Database(':memory:')); });

// ---- the settings table can enumerate itself now ------------------------------------

test('SettingsRepository.keys() lists what is stored — the sweep needs the table, not a list', () => {
  const repos = fresh();
  repos.settings.set('google.refresh_token', 'x');
  repos.settings.set('digest.smtp_password', 'y');
  expect(repos.settings.keys().sort()).toEqual(['digest.smtp_password', 'google.refresh_token']);
  repos.settings.remove('digest.smtp_password');
  expect(repos.settings.keys()).toEqual(['google.refresh_token']);
});

// ---- the redaction test -------------------------------------------------------------

test('the redaction test: nothing secret survives, and the ordinary lines do', async () => {
  const repos = fresh();
  seedSecrets(repos);

  const report = await buildReport({
    repos, ...CONNECTED, screen: '/tickets/tkt_def42d05e31c45f7',
    packaged: true, logPath: tempLog(FIXTURE_LOG),
  });
  const { body } = report;

  // The five, by their actual values.
  expect(body).not.toContain(SECRETS.refresh);
  expect(body).not.toContain(SECRETS.access);
  expect(body).not.toContain(SECRETS.code);
  expect(body).not.toContain(SECRETS.password);
  expect(body).not.toContain(HOME);
  // And everything else the table held.
  expect(body).not.toContain(SECRETS.account);
  expect(body).not.toContain(SECRETS.mirror);
  expect(body).not.toContain(SECRETS.to);
  expect(body).not.toContain(SECRETS.host);
  expect(body).not.toContain('ya29.');
  expect(body).not.toContain('Bearer ' + SECRETS.access);

  // A redactor that passes by deleting everything is not a redactor.
  expect(body).toContain('Northern Roofing');
  expect(body).toContain('2026-08-06T09:00:01.000Z');
  expect(body).toContain('[fatal] Error: ENOENT ~/Library/Application Support/STEWARD/steward.db');
  expect(body).toContain('[server] ready');
  // The timestamp is intact even though `digest.last_sent_on` holds that very date.
  expect(body).toContain('2026-08-06T09:00:09.000Z [server] ready');
});

test('the omission test: connected Google and a stored password reach the body as booleans', async () => {
  const repos = fresh();
  seedSecrets(repos);
  const report = await buildReport({ repos, ...CONNECTED, screen: '/settings', packaged: false });

  expect(report.body).not.toContain(SECRETS.account);
  expect(report.body).not.toContain(SECRETS.mirror);
  expect(report.body).not.toContain(SECRETS.password);
  expect(report.body).not.toContain(HOME);
  // What it says instead — the diagnostic without the identity.
  expect(report.body).toMatch(/^Google +connected$/m);
  expect(report.body).toContain('a mirror exists');
  expect(report.body).toContain('password stored');
  expect(report.body).toContain('port 465');
});

test('the redactor keeps its own rules straight', () => {
  const sources = { home: '/Users/jo', secrets: ['supersecretvalue', '465', null] };
  expect(redact('at /Users/jo/x and C:\\Users\\jo\\y', { home: 'C:\\Users\\jo' }))
    .toBe('at /Users/jo/x and ~\\y');
  expect(redact('key=supersecretvalue port=465', sources)).toBe('key=<redacted> port=465');
  expect(redact('write to jo@example.com now', sources)).toBe('write to <email> now');
  expect(redact('?client_secret=GOCSPX-abc123&x=1', sources))
    .toBe('?client_secret=<redacted>&x=1');
  // Short values, and values that are only a date or a number, are left alone: scrubbing
  // them turns a log into placeholder soup and its timestamps into nonsense.
  expect(isSweepable('465')).toBe(false);
  expect(isSweepable('2026-08-06')).toBe(false);
  expect(isSweepable('2026-08-06T09:00:01.000Z')).toBe(false);
  expect(isSweepable('08:00')).toBe(false);
  expect(isSweepable('abcdefgh')).toBe(true);
  // Redaction is idempotent — it runs inside the budget loop, once per candidate body.
  const once = redact(FIXTURE_LOG, { home: HOME, secrets: Object.values(SECRETS) });
  expect(redact(once, { home: HOME, secrets: Object.values(SECRETS) })).toBe(once);
});

// ---- the budget test ----------------------------------------------------------------

test('the budget test: a megabyte of pathological log still fits in 8 KB', async () => {
  const noisy = Array.from(
    { length: 12_000 },
    (_, i) => `2026-08-06T09:00:00.000Z [noise ${i}] a#b&c+d "quoted" — é 中 ${'x'.repeat(40)}`,
  );
  noisy.push('2026-08-06T09:59:59.000Z [last] the newest line, next to the crash #999 & +');
  const text = noisy.join('\n');
  expect(text.length).toBeGreaterThan(1_000_000);

  const repos = fresh();
  seedSecrets(repos);
  const report = await buildReport({
    repos, ...CONNECTED, screen: '/tickets', packaged: true, logPath: tempLog(text),
  });

  expect(report.bytes).toBeLessThanOrEqual(URL_BUDGET);
  expect(report.overBudget).toBe(false);
  expect(report.logIncluded).toBe(true);
  // The newest lines are the ones next to the crash, so those are the ones kept.
  expect(report.body).toContain('the newest line, next to the crash #999 & +');
  // Truncation the reader cannot see is worse than truncation.
  expect(report.dropped).toBeGreaterThan(0);
  expect(report.body).toContain(DROP_MARKER);

  // The round trip: what GitHub receives decodes back to exactly what was rendered.
  const parsed = new URL(report.url);
  expect(parsed.origin + parsed.pathname).toBe('https://github.com/tjakoen/steward/issues/new');
  expect(parsed.searchParams.get('body')).toBe(report.body);
  expect(parsed.searchParams.get('title')).toBe(report.title);
  expect(parsed.searchParams.get('labels')).toBe('bug');
  expect(report.url.length).toBe(report.bytes);
});

test('a body that cannot fit at all degrades to "log omitted", not to an oversized URL', () => {
  const list = facts({
    version: 'dev', packaged: false, platform: 'darwin', arch: 'arm64', osRelease: '25.1.0',
    bunVersion: '1.3.14', uptimeSeconds: 12, dataDirOverridden: false,
    google: { configured: false, connected: false },
    mirror: { configured: false, connected: false, hasMirror: false },
    digest: {
      enabled: false, time: '08:00', port: 465, hasHost: false, hasUser: false,
      hasRecipient: false, hasPassword: false, lastSentOn: '',
    },
    chromePath: null, counts: { clients: 0, customers: 0, tickets: 0, documents: 0 },
    screen: '/tickets', log: { available: true, hasOld: false },
  });
  const log = {
    available: true, reason: '', truncated: false, hasOld: false, path: '/tmp/steward.log',
    text: `one enormous line ${'y'.repeat(9_000)}`,
  };

  const tight = buildBody({ facts: list, log, title: 'Bug', budget: 3_000 });
  expect(tight.logIncluded).toBe(false);
  expect(tight.overBudget).toBe(false);
  expect(tight.bytes).toBeLessThanOrEqual(3_000);
  expect(tight.body).toContain('did not fit inside the URL');

  // And when even the diagnostics do not fit there is nothing left to drop, so it says
  // so rather than handing the browser a URL GitHub answers 414 to.
  const impossible = buildBody({ facts: list, log, title: 'Bug', budget: 200 });
  expect(impossible.overBudget).toBe(true);
  expect(impossible.logIncluded).toBe(false);
});

test('encodeURIComponent, not encodeURI: the four characters that break a naive build', () => {
  const body = 'issue #3\nfoo&bar=baz\na + b';
  const url = issueUrl('a#b&c+d', body);
  for (const raw of ['#', '\n', '+']) expect(url.slice(url.indexOf('?'))).not.toContain(raw);
  // One `&` per parameter separator and no more: a stack trace cannot inject a third.
  expect(url.split('&').length).toBe(3);
  expect(new URL(url).searchParams.get('body')).toBe(body);
  expect(new URL(url).searchParams.get('title')).toBe('a#b&c+d');
});

// ---- the log tail -------------------------------------------------------------------

test('the tail is taken by byte offset and starts at a line boundary', async () => {
  // A multibyte character sitting across the cut: slicing mid-character would yield a
  // replacement character, and dropping the half-line fixes both problems at once.
  const filler = `${'é'.repeat(TAIL_BYTES)}\n`;
  const path = tempLog(`${filler}kept line one\nkept line two`);

  const tail = await readLogTail({ packaged: true, path });
  expect(tail.available).toBe(true);
  expect(tail.truncated).toBe(true);
  expect(tail.text).not.toContain('\uFFFD');
  expect(tail.text).toBe('kept line one\nkept line two');
  expect(tail.hasOld).toBe(false);
});

test('a checkout has no log file, says why, and the report is otherwise complete', async () => {
  const repos = fresh();
  const report = await buildReport({
    repos,
    google: { configured: false, connected: false },
    mirror: { configured: false, connected: false, url: null },
    screen: null, packaged: false,
  });
  expect(report.log.available).toBe(false);
  expect(report.logIncluded).toBe(false);
  expect(report.body).toContain('logs to the console rather than to a file');
  expect(report.body).toContain('### What happened');
  expect(report.body).toMatch(/^Google +not configured$/m);
  expect(report.body).toMatch(/^Screen +unknown$/m);
  expect(report.bytes).toBeLessThan(URL_BUDGET);
});

// ---- the facts ----------------------------------------------------------------------

test('the referring screen is normalised down to the surface', () => {
  expect(normaliseScreen('http://localhost:3214/tickets/tkt_def42d05e31c45f7')).toBe('/tickets/:id');
  expect(normaliseScreen('/customers/cus_0123456789abcdef')).toBe('/customers/:id');
  expect(normaliseScreen('/tickets/TXDOEX0001')).toBe('/tickets/:id');
  expect(normaliseScreen('/clients?filter=northern')).toBe('/clients');
  expect(normaliseScreen('/')).toBe('/');
  expect(normaliseScreen(null)).toBe('unknown');
  expect(normaliseScreen('nonsense')).toBe('unknown');
});

test('paths are printed as shapes, and a browser by its name alone', () => {
  expect(dataDirShape('win32', true, false)).toBe('%LOCALAPPDATA%\\STEWARD');
  expect(dataDirShape('darwin', true, false)).toBe('~/Library/Application Support/STEWARD');
  expect(dataDirShape('linux', true, false)).toBe('~/.local/share/steward');
  expect(dataDirShape('darwin', true, true)).toBe('STEWARD_DATA is set');
  expect(chromeLabel('C:\\Users\\jo\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'))
    .toBe('chrome.exe');
  expect(chromeLabel('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))
    .toBe('Google Chrome');
  expect(chromeLabel(null)).toContain('none found');
  expect(uptimeLabel(12)).toBe('12s');
  expect(uptimeLabel(192)).toBe('3m 12s');
  expect(uptimeLabel(21_720)).toBe('6h 02m');
});

// ---- the page -----------------------------------------------------------------------

test('the page shows the exact body in an editable textarea, and carries no secret', async () => {
  const repos = fresh();
  seedSecrets(repos);
  const report = await buildReport({
    repos, ...CONNECTED, screen: '/tickets/tkt_def42d05e31c45f7',
    packaged: true, logPath: tempLog(FIXTURE_LOG),
  });
  const html = reportPage(report);

  expect(html).toContain('<textarea class="report-box" id="report-body"');
  expect(html).toContain('### What happened');
  expect(html).toContain('from /tickets/:id');
  // An anchor, never a spawn: `cmd /c start` on Windows treats `&` as a command separator.
  expect(html).toContain('id="report-open" target="_blank" rel="noopener"');
  expect(html).toContain('Copy');
  expect(html).toContain('Save to a file');
  for (const secret of Object.values(SECRETS)) expect(html).not.toContain(secret);
  expect(html).not.toContain(HOME);
});
