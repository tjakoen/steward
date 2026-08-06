import { test, expect } from 'bun:test';
import { makeSheetsMirror } from './sheets.ts';
import { TAB_TITLES, type MirrorData } from './mirror.ts';
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
function kindOf(url: string, method: string): string {
  if (url.includes('sheets.googleapis.com')) {
    if (url.includes('values:batchClear')) return 'clear';
    if (url.includes('values:batchUpdate')) return 'write';
    if (url.includes(':batchUpdate')) return 'batchUpdate';
    if (method === 'POST') return 'create';
    return 'meta';
  }
  if (method === 'PATCH') return 'move';
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
    const call: Call = { kind: kindOf(url, method), url, method, body };
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

  expect(kinds()).toEqual([
    'create', 'batchUpdate', 'folderSearch', 'move',
    'meta', 'batchUpdate', 'clear', 'write',
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

test('every tab is protected with a warning, and the header rows are frozen', async () => {
  const { impl, calls } = fakeGoogle();
  const mirror = makeSheetsMirror(settingsStub(), authWith('tok'), 'STEWARD', impl, 'client');
  await mirror.push(EMPTY);

  const create = calls.find((c) => c.kind === 'create')!.body as {
    sheets: { properties: { gridProperties: { frozenRowCount: number } } }[];
  };
  expect(create.sheets.every((s) => s.properties.gridProperties.frozenRowCount === 2)).toBe(true);

  const dress = calls.filter((c) => c.kind === 'batchUpdate')[0].body as { requests: Record<string, unknown>[] };
  const protections = dress.requests.filter((r) => 'addProtectedRange' in r);
  expect(protections.length).toBe(TAB_TITLES.length);
  expect(protections.every((r) => (r.addProtectedRange as { protectedRange: { warningOnly: boolean } }).protectedRange.warningOnly)).toBe(true);
});

test('a second push reuses the stored spreadsheet and does not create another', async () => {
  const { impl, kinds } = fakeGoogle();
  const settings = settingsStub({ 'sheets.spreadsheet_id': 'sheet_1', 'sheets.spreadsheet_url': 'u' });
  const mirror = makeSheetsMirror(settings, authWith('tok'), 'STEWARD', impl, 'client');

  const out = await mirror.push(EMPTY);
  expect(out.ok).toBe(true);
  expect(kinds()).toEqual(['meta', 'batchUpdate', 'clear', 'write']);
  expect(kinds()).not.toContain('create');
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
    'meta', 'create', 'batchUpdate', 'folderSearch', 'move',
    'meta', 'batchUpdate', 'clear', 'write',
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

test('forget clears the local record and nothing else', async () => {
  const { impl, calls } = fakeGoogle();
  const settings = settingsStub({
    'sheets.spreadsheet_id': 'sheet_1', 'sheets.spreadsheet_url': 'u', 'sheets.pushed_at': 'then',
  });
  const mirror = makeSheetsMirror(settings, authWith('tok'), 'STEWARD', impl, 'client');
  mirror.forget();

  expect(mirror.state()).toEqual({ configured: true, connected: true, url: null, pushedAt: null });
  expect(calls.length).toBe(0); // the spreadsheet itself stays in the operator's Drive
});
