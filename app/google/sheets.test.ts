import { test, expect } from 'bun:test';
import { makeSheetsMirror } from './sheets.ts';
import { PULL_COLUMNS, TAB_TITLES, headersFor, type MirrorData } from './mirror.ts';
import type { GoogleAuth } from './oauth.ts';
import type { SettingsRepository } from '../repo/ports.ts';

const EMPTY: MirrorData = { clients: [], customers: [], tickets: [] };

const settingsStub = (seed: Record<string, string> = {}): SettingsRepository => {
  const m = new Map(Object.entries(seed));
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => { m.set(k, v); },
    remove: (k) => { m.delete(k); },
    keys: () => [...m.keys()],
  };
};

const authWith = (token: string | null): GoogleAuth => ({
  accessToken: async () => token,
  status: () => ({ configured: true, connected: token !== null, account: null }),
} as unknown as GoogleAuth);

interface Call { kind: string; url: string; method: string; body: unknown }

/** What a call IS, so a test can assert the sequence rather than the URLs. */
function kindOf(url: string, method: string, body: unknown): string {
  if (url.includes('sheets.googleapis.com')) {
    if (url.includes('values:batchClear')) return 'clear';
    if (url.includes('values:batchGet')) {
      return url.includes('UNFORMATTED_VALUE') ? 'readRaw' : 'readText';
    }
    if (url.includes('values:batchUpdate')) return 'write';
    if (url.includes(':batchUpdate')) return 'batchUpdate';
    if (method === 'POST') return 'create';
    return 'meta';
  }
  // Drive. A PATCH carrying a name is 0011's one-time rename; one carrying parents is
  // the mirror filing itself.
  if (method === 'PATCH') return (body as { name?: string })?.name ? 'rename' : 'move';
  return method === 'POST' ? 'folderCreate' : 'folderSearch';
}

const SHEET_IDS: Record<string, number> = { Clients: 0, Customers: 1, Tickets: 2, Progress: 3 };

/**
 * A Google stand-in that answers plausibly by default. `intercept` may return a
 * Response (or a plain object) for a given call to stage a failure.
 */
function fakeGoogle(intercept: (c: Call, index: number) => unknown = () => undefined) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const call: Call = { kind: kindOf(url, method, body), url, method, body };
    calls.push(call);

    const staged = intercept(call, calls.length - 1);
    if (staged instanceof Response) return staged;
    if (staged !== undefined) return new Response(JSON.stringify(staged), { status: 200 });

    const reply = (() => {
      switch (call.kind) {
        case 'create':
          return {
            spreadsheetId: 'sheet_1',
            spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet_1',
            sheets: (body.sheets as { properties: { title: string } }[]).map((s) => ({
              properties: { sheetId: SHEET_IDS[s.properties.title] ?? 9, title: s.properties.title },
            })),
          };
        case 'meta':
          return {
            sheets: TAB_TITLES.map((title) => ({ properties: { sheetId: SHEET_IDS[title], title } })),
          };
        case 'batchUpdate':
          return {
            replies: (body.requests as { addSheet?: { properties: { title: string } } }[]).map((r) =>
              r.addSheet ? { addSheet: { properties: { sheetId: 42, title: r.addSheet.properties.title } } } : {}),
          };
        case 'folderSearch': return { files: [{ id: 'folder_1' }] };
        // An empty mirror reads back as nothing at all, so the interlock sees no edits.
        case 'readRaw': case 'readText': return { valueRanges: [{}, {}, {}] };
        default: return {};
      }
    })();
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as unknown as typeof fetch;

  return { impl, calls, kinds: () => calls.map((c) => c.kind) };
}

test('a first push creates the spreadsheet, dresses it, files it, then writes', async () => {
  const { impl, calls, kinds } = fakeGoogle();
  const settings = settingsStub();
  const mirror = makeSheetsMirror(settings, authWith('tok'), 'STEWARD', impl, 'client');

  const out = await mirror.push(EMPTY);
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.url).toBe('https://docs.google.com/spreadsheets/d/sheet_1');
  expect(out.recreated).toBe(false);
  expect(out.note).toBeUndefined();

  // No interlock read: there is no mirror yet, so there is nothing anyone could have typed.
  expect(kinds()).toEqual([
    'create', 'batchUpdate', 'folderSearch', 'move',
    'meta', 'batchUpdate', 'batchUpdate', 'clear', 'write',
  ]);
  // Clearing BEFORE writing is the whole reason deleted records don't linger.
  expect(kinds().indexOf('clear')).toBeLessThan(kinds().indexOf('write'));
  expect(calls.every((c) => JSON.parse(JSON.stringify(c)) && true)).toBe(true);
  expect(settings.get('sheets.spreadsheet_id')).toBe('sheet_1');
  expect(settings.get('sheets.pushed_at')).toBe(out.pushedAt);
});

test('the write is RAW, so a leading "=" stays text', async () => {
  const { impl, calls } = fakeGoogle();
  const mirror = makeSheetsMirror(settingsStub(), authWith('tok'), 'STEWARD', impl, 'client');
  await mirror.push(EMPTY);

  const write = calls.find((c) => c.kind === 'write')!.body as { valueInputOption: string; data: unknown[] };
  expect(write.valueInputOption).toBe('RAW');
  expect(write.data.length).toBe(TAB_TITLES.length);
});

interface ProtectedRange {
  range: { sheetId: number; startColumnIndex?: number; endColumnIndex?: number };
  warningOnly: boolean;
  description: string;
}
const protectionsIn = (body: unknown): ProtectedRange[] =>
  (body as { requests: Record<string, unknown>[] }).requests
    .filter((r) => 'addProtectedRange' in r)
    .map((r) => (r.addProtectedRange as { protectedRange: ProtectedRange }).protectedRange);

test('the warnings are warnings, and the header rows are frozen', async () => {
  const { impl, calls } = fakeGoogle();
  const mirror = makeSheetsMirror(settingsStub(), authWith('tok'), 'STEWARD', impl, 'client');
  await mirror.push(EMPTY);

  const create = calls.find((c) => c.kind === 'create')!.body as {
    sheets: { properties: { gridProperties: { frozenRowCount: number } } }[];
  };
  expect(create.sheets.every((s) => s.properties.gridProperties.frozenRowCount === 2)).toBe(true);

  const ranges = protectionsIn(calls.filter((c) => c.kind === 'batchUpdate')[0].body);
  // warningOnly, never a real permission: the operator owns the file (0010's reasoning).
  expect(ranges.every((r) => r.warningOnly)).toBe(true);
  expect(ranges.some((r) => r.description.includes('record id'))).toBe(true);
  expect(ranges.some((r) => r.description.includes('not read back'))).toBe(true);
});

test('the pullable columns carry NO warning — they are the point of the feature', async () => {
  const { impl, calls } = fakeGoogle();
  const mirror = makeSheetsMirror(settingsStub(), authWith('tok'), 'STEWARD', impl, 'client');
  await mirror.push(EMPTY);

  const covered = new Set<number>();
  for (const r of protectionsIn(calls.filter((c) => c.kind === 'batchUpdate')[0].body)) {
    if (r.range.sheetId !== SHEET_IDS.Tickets || r.range.startColumnIndex === undefined) continue;
    for (let i = r.range.startColumnIndex; i < r.range.endColumnIndex!; i += 1) covered.add(i);
  }
  const headers = headersFor('Tickets');
  for (const c of PULL_COLUMNS.Tickets) expect(covered.has(headers.indexOf(c.header))).toBe(false);
  // ...while the derived ones do, including the two that would silently re-parent a ticket.
  expect(covered.has(headers.indexOf('client code'))).toBe(true);
  expect(covered.has(headers.indexOf('customer'))).toBe(true);
  expect(covered.has(headers.indexOf('last updated'))).toBe(true);
  expect(covered.has(0)).toBe(true); // the id column, with its own sentence
});

test('a second push reuses the stored spreadsheet and does not create another', async () => {
  const { impl, kinds } = fakeGoogle();
  const settings = settingsStub({
    'sheets.spreadsheet_id': 'sheet_1', 'sheets.spreadsheet_url': 'u', 'sheets.title': 'STEWARD mirror',
  });
  const mirror = makeSheetsMirror(settings, authWith('tok'), 'STEWARD', impl, 'client');

  const out = await mirror.push(EMPTY);
  expect(out.ok).toBe(true);
  // The interlock reads the sheet first, and finds nothing anyone typed.
  expect(kinds()).toEqual([
    'readRaw', 'readText', 'meta', 'batchUpdate', 'batchUpdate', 'clear', 'write',
  ]);
  expect(kinds()).not.toContain('create');
});

test('an existing mirror is renamed once, and re-dressed so 0010 guards stop lying', async () => {
  const { impl, calls, kinds } = fakeGoogle((c) =>
    // A mirror made by 0010: one whole-tab protected range per tab.
    c.kind === 'meta'
      ? { sheets: TAB_TITLES.map((title) => ({
          properties: { sheetId: SHEET_IDS[title], title },
          protectedRanges: [{ protectedRangeId: 100 + SHEET_IDS[title] }],
        })) }
      : undefined);
  const settings = settingsStub({ 'sheets.spreadsheet_id': 'sheet_1' });
  const mirror = makeSheetsMirror(settings, authWith('tok'), 'STEWARD', impl, 'client');
  await mirror.push(EMPTY);

  expect(kinds()).toContain('rename');
  expect(calls.find((c) => c.kind === 'rename')!.body).toEqual({ name: 'STEWARD mirror' });
  expect(settings.get('sheets.title')).toBe('STEWARD mirror');

  // The old warnings are deleted, not left sitting over columns that are now read back.
  const first = (calls.filter((c) => c.kind === 'batchUpdate')[0].body as { requests: Record<string, unknown>[] }).requests;
  expect(first.filter((r) => 'deleteProtectedRange' in r).length).toBe(TAB_TITLES.length);
  expect(protectionsIn(calls.filter((c) => c.kind === 'batchUpdate')[1].body).length).toBeGreaterThan(TAB_TITLES.length);

  // ...and a second push does not rename again.
  const before = calls.length;
  await mirror.push(EMPTY);
  expect(calls.slice(before).some((c) => c.kind === 'rename')).toBe(false);
});

test('the grid is grown before the write, because values.update refuses a range past it', async () => {
  const { impl, calls } = fakeGoogle();
  const settings = settingsStub({ 'sheets.spreadsheet_id': 'sheet_1' });
  const mirror = makeSheetsMirror(settings, authWith('tok'), 'STEWARD', impl, 'client');

  const clients = Array.from({ length: 2_000 }, (_, i) => ({
    id: `c${i}`, name: `n${i}`, code: `C${i}`, archivedAt: null,
    branding: { logoDataUrl: null, primaryColor: '', secondaryColor: '', companyInfo: '', pdfFooter: '' },
    createdAt: '', updatedAt: '',
  }));
  await mirror.push({ ...EMPTY, clients });

  const sizing = calls.find((c) => c.kind === 'batchUpdate')!.body as {
    requests: { updateSheetProperties?: { properties: { sheetId: number; gridProperties: { rowCount: number } } } }[];
  };
  const clientsReq = sizing.requests.find((r) => r.updateSheetProperties?.properties.sheetId === 0);
  expect(clientsReq!.updateSheetProperties!.properties.gridProperties.rowCount).toBeGreaterThan(2_001);
});

test('a trashed spreadsheet is recreated, and the push says so', async () => {
  // The stored id is stale: the metadata read 404s, once.
  let gone = true;
  const { impl, kinds } = fakeGoogle((c) => {
    if (c.kind === 'meta' && gone) {
      gone = false;
      return new Response(JSON.stringify({ error: { message: 'File not found: sheet_old.' } }), { status: 404 });
    }
    return undefined;
  });
  const settings = settingsStub({ 'sheets.spreadsheet_id': 'sheet_old' });
  const mirror = makeSheetsMirror(settings, authWith('tok'), 'STEWARD', impl, 'client');

  const out = await mirror.push(EMPTY);
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.recreated).toBe(true);
  expect(settings.get('sheets.spreadsheet_id')).toBe('sheet_1');
  expect(kinds()).toEqual([
    'readRaw', 'readText',
    'meta', 'create', 'batchUpdate', 'folderSearch', 'move',
    'meta', 'batchUpdate', 'batchUpdate', 'clear', 'write',
  ]);
});

test('a re-added tab comes back dressed, not bare', async () => {
  const { impl, calls } = fakeGoogle((c) => {
    if (c.kind !== 'meta') return undefined;
    // The operator deleted the Progress tab.
    return { sheets: TAB_TITLES.filter((t) => t !== 'Progress').map((title) => ({ properties: { sheetId: SHEET_IDS[title], title } })) };
  });
  const settings = settingsStub({ 'sheets.spreadsheet_id': 'sheet_1' });
  const mirror = makeSheetsMirror(settings, authWith('tok'), 'STEWARD', impl, 'client');
  await mirror.push(EMPTY);

  const batches = calls.filter((c) => c.kind === 'batchUpdate');
  const added = (batches[0].body as { requests: Record<string, unknown>[] }).requests
    .filter((r) => 'addSheet' in r);
  expect(added.length).toBe(1);
  // The second batch dresses what was just added: bold header, protection, widths.
  const dress = (batches[1].body as { requests: Record<string, unknown>[] }).requests;
  expect(dress.some((r) => 'addProtectedRange' in r)).toBe(true);
});

test('the Sheets API being switched off is reported as itself, with the link', async () => {
  const message =
    'Google Sheets API has not been used in project 308363978170 before or it is disabled. ' +
    'Enable it by visiting https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=308363978170 then retry.';
  const { impl } = fakeGoogle((c) =>
    c.kind === 'create' ? new Response(JSON.stringify({ error: { message } }), { status: 403 }) : undefined);
  const mirror = makeSheetsMirror(settingsStub(), authWith('tok'), 'STEWARD', impl, 'client');

  const out = await mirror.push(EMPTY);
  expect(out.ok).toBe(false);
  if (out.ok) return;
  expect(out.reason).toBe(message);
  expect(out.enableUrl).toBe(
    'https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=308363978170',
  );
});

test('a failure to file the mirror is a note, not a failed push', async () => {
  const { impl } = fakeGoogle((c) =>
    c.kind === 'move' ? new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 500 }) : undefined);
  const mirror = makeSheetsMirror(settingsStub(), authWith('tok'), 'STEWARD', impl, 'client');

  const out = await mirror.push(EMPTY);
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.note).toContain('My Drive');
});

test('any other failure leaves the stored mirror alone and reports the message', async () => {
  const { impl } = fakeGoogle((c) =>
    c.kind === 'write' ? new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), { status: 429 }) : undefined);
  const settings = settingsStub({ 'sheets.spreadsheet_id': 'sheet_1' });
  const mirror = makeSheetsMirror(settings, authWith('tok'), 'STEWARD', impl, 'client');

  const out = await mirror.push(EMPTY);
  expect(out.ok).toBe(false);
  if (out.ok) return;
  expect(out.reason).toContain('quota exceeded');
  expect(settings.get('sheets.spreadsheet_id')).toBe('sheet_1');
  expect(settings.get('sheets.pushed_at')).toBeNull(); // a failed push never claims a time
});

test('a push while disconnected says so and never reaches the network', async () => {
  const { impl, calls } = fakeGoogle();
  const mirror = makeSheetsMirror(settingsStub(), authWith(null), 'STEWARD', impl, 'client');

  const out = await mirror.push(EMPTY);
  expect(out.ok).toBe(false);
  if (out.ok) return;
  expect(out.reason).toContain('not connected');
  expect(calls.length).toBe(0);
});

// --- the interlock (0011) ---------------------------------------------------
//
// The mirror write is clear-then-write. That was merely destructive-by-design while
// nothing read the file back; the day a pull exists, the operator has a real reason to
// type in there and a real expectation that their typing survives.

const pushed = (extra: Record<string, string> = {}) => settingsStub({
  'sheets.spreadsheet_id': 'sheet_1', 'sheets.spreadsheet_url': 'u',
  'sheets.title': 'STEWARD mirror', 'sheets.pushed_at': '2026-08-05T08:00:00.000Z', ...extra,
});

// --- the pull (0011) --------------------------------------------------------

const CLIENT = {
  id: 'cl_1', name: 'Acme', code: 'ACME', archivedAt: null,
  branding: { logoDataUrl: null, primaryColor: '', secondaryColor: '', companyInfo: '', pdfFooter: '' },
  createdAt: '2026-01-01', updatedAt: '2026-01-01',
};
// Eight customers that are NOT in the sheet, which is two things at once: a record absent
// from the mirror is ignored (a pull deletes nothing), and the workspace is big enough that
// one changed record is nowhere near the blast-radius threshold.
const DATA: MirrorData = {
  clients: [CLIENT],
  customers: Array.from({ length: 8 }, (_, i) => ({
    id: `cu_${i}`, clientId: 'cl_1', code: `C${i}`, persons: [{ given: 'A', family: 'B' }],
    email: '', phone: '', externalId: '', notes: '', archivedAt: null,
    createdAt: '2026-01-01', updatedAt: '2026-01-01',
  })),
  tickets: [],
};

/** The mirror as Google would hand it back: banner, header, then rows. */
const tabValues = (rows: unknown[][]) => ({
  values: [['banner'], headersFor('Clients'), ...rows],
});

const withSheet = (rows: unknown[][]) => fakeGoogle((c) => {
  if (c.kind === 'readRaw' || c.kind === 'readText') {
    return { valueRanges: [tabValues(rows), { values: [[], headersFor('Customers')] }, { values: [[], headersFor('Tickets')] }] };
  }
  return undefined;
});

test('a preview reads twice, writes nothing, and reports the diff', async () => {
  const { impl, kinds } = withSheet([['cl_1', 'ACME', 'Acme Holdings', '', '2026-01-01', '2026-01-01']]);
  const mirror = makeSheetsMirror(
    pushed({ 'google.account': 'op@example.com' }), authWith('tok'), 'STEWARD', impl, 'client',
  );

  const out = await mirror.pullPreview(DATA);
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.actor).toBe('sheet:op@example.com');
  expect(out.revision).toBeTruthy();
  expect(out.plan.changes).toHaveLength(1);
  expect(out.plan.changes[0].fields).toEqual([{ header: 'name', from: 'Acme', to: 'Acme Holdings' }]);
  // Both render options, and NOTHING that writes.
  expect(kinds()).toContain('readRaw');
  expect(kinds()).toContain('readText');
  expect(kinds().some((k) => ['write', 'clear', 'batchUpdate'].includes(k))).toBe(false);
});

test('an unnamed account is sheet:unknown, never "human"', async () => {
  const { impl } = withSheet([]);
  const mirror = makeSheetsMirror(pushed(), authWith('tok'), 'STEWARD', impl, 'client');
  const out = await mirror.pullPreview(DATA);
  // A false attribution in an append-only table is worse than an honest blank.
  expect(out.ok && out.actor).toBe('sheet:unknown');
});

test('apply refuses when the sheet moved since the preview', async () => {
  const { impl } = withSheet([['cl_1', 'ACME', 'Acme Holdings', '', '2026-01-01', '2026-01-01']]);
  const mirror = makeSheetsMirror(pushed(), authWith('tok'), 'STEWARD', impl, 'client');
  let applied = 0;

  const out = await mirror.pullApply(DATA, { revision: 'an older revision' }, () => (applied += 1));
  expect(out.ok).toBe(false);
  if (out.ok) return;
  expect(out.reason).toContain('no longer the one that was previewed');
  expect(applied).toBe(0);
});

test('apply writes once, records the pull, and stamps the sheet actor', async () => {
  const { impl } = withSheet([['cl_1', 'ACME', 'Acme Holdings', '', '2026-01-01', '2026-01-01']]);
  const settings = pushed({ 'google.account': 'op@example.com' });
  const mirror = makeSheetsMirror(settings, authWith('tok'), 'STEWARD', impl, 'client');

  const preview = await mirror.pullPreview(DATA);
  expect(preview.ok).toBe(true);
  if (!preview.ok) return;

  const seen: string[] = [];
  const out = await mirror.pullApply(DATA, { revision: preview.revision }, (plan, actor) => {
    seen.push(actor);
    return plan.changes.length;
  });
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.applied).toBe(1);
  expect(seen).toEqual(['sheet:op@example.com']);
  expect(settings.get('sheets.pulled_at')).toBe(out.pulledAt);
});

// The interlock, which asks the SHEET rather than a clock. Drive's `modifiedTime` lags a
// Sheets content edit by up to a minute (measured 2026-08-07), so a timestamp guard is
// blind for exactly as long as it takes somebody to type and then hit push.

test('a push refuses when the sheet holds edits nobody pulled, and names them', async () => {
  const { impl, kinds } = withSheet([['cl_1', 'ACME', 'Acme Holdings', '', '2026-01-01', '2026-01-01']]);
  const settings = pushed();
  const mirror = makeSheetsMirror(settings, authWith('tok'), 'STEWARD', impl, 'client');

  const out = await mirror.push(DATA);
  expect(out.ok).toBe(false);
  if (out.ok) return;
  expect(out.stale).toBe(true);
  expect(out.reason).toContain('1 record edited');
  expect(out.reason).toContain('Pull those edits first');
  // Nothing was cleared, nothing was written — the refusal happens before any of it.
  expect(kinds()).toEqual(['readRaw', 'readText']);
  expect(settings.get('sheets.pushed_at')).toBe('2026-08-05T08:00:00.000Z');
});

test('a half-typed new row also blocks a push, because a push would erase it', async () => {
  const { impl } = withSheet([
    ['cl_1', 'ACME', 'Acme', '', '2026-01-01', '2026-01-01'],
    ['', '', 'Somebody was typing here'],
  ]);
  const out = await makeSheetsMirror(pushed(), authWith('tok'), 'STEWARD', impl, 'client').push(DATA);
  expect(out.ok).toBe(false);
  if (out.ok) return;
  expect(out.reason).toContain('1 new row');
});

test('a cell that cannot be read blocks a push too — it is still somebody\'s typing', async () => {
  const { impl } = withSheet([['cl_1', 'ACME', '', '', '2026-01-01', '2026-01-01']]);
  const out = await makeSheetsMirror(pushed(), authWith('tok'), 'STEWARD', impl, 'client').push(DATA);
  expect(out.ok).toBe(false);
  if (out.ok) return;
  expect(out.reason).toContain('1 cell that cannot be read');
});

test('editing a GREY column does not block a push — it is overwritten by design', async () => {
  const { impl } = withSheet([['cl_1', 'RENAMED', 'Acme', '', '2026-01-01', '2026-01-01']]);
  const out = await makeSheetsMirror(pushed(), authWith('tok'), 'STEWARD', impl, 'client').push(DATA);
  expect(out.ok).toBe(true);
});

test('force pushes anyway — that is what makes the discard deliberate', async () => {
  const { impl, kinds } = withSheet([['cl_1', 'ACME', 'Acme Holdings', '', '2026-01-01', '2026-01-01']]);
  const out = await makeSheetsMirror(pushed(), authWith('tok'), 'STEWARD', impl, 'client')
    .push(DATA, { force: true });

  expect(out.ok).toBe(true);
  expect(kinds()).toContain('write');
  // The check is SKIPPED, not merely overruled: the sheet is never even read.
  expect(kinds()).not.toContain('readRaw');
});

test('a first push has no mirror to check, so it is never blocked', async () => {
  const { impl, kinds } = withSheet([]);
  const settings = settingsStub();
  expect((await makeSheetsMirror(settings, authWith('tok'), 'STEWARD', impl, 'client').push(DATA)).ok).toBe(true);
  expect(kinds()).not.toContain('readRaw');
});

test('a pull while disconnected is a reason, not a throw', async () => {
  const { impl, calls } = fakeGoogle();
  const mirror = makeSheetsMirror(pushed(), authWith(null), 'STEWARD', impl, 'client');
  const out = await mirror.pullPreview(DATA);
  expect(out.ok).toBe(false);
  if (out.ok) return;
  expect(out.reason).toContain('not connected');
  expect(calls.length).toBe(0);
});

test('forget clears the local record and nothing else', async () => {
  const { impl, calls } = fakeGoogle();
  const settings = settingsStub({
    'sheets.spreadsheet_id': 'sheet_1', 'sheets.spreadsheet_url': 'u', 'sheets.pushed_at': 'then',
  });
  const mirror = makeSheetsMirror(settings, authWith('tok'), 'STEWARD', impl, 'client');
  mirror.forget();

  expect(mirror.state()).toEqual({
    configured: true, connected: true, url: null, pushedAt: null, pulledAt: null,
  });
  expect(calls.length).toBe(0); // the spreadsheet itself stays in the operator's Drive
});
