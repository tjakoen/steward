import { test, expect } from 'bun:test';
import {
  PULL_COLUMNS, PULL_TABS, TAB_TITLES,
  derivedHeaders, headersFor, mirrorCounts, mirrorTabs, type MirrorData,
} from './mirror.ts';
import type { Client, Customer, Ticket } from '../domain/types.ts';

const AT = '2026-08-01T10:00:00.000Z';

const client = (over: Partial<Client> = {}): Client => ({
  id: 'c1', name: 'Acme', code: 'ACME', archivedAt: null,
  branding: {
    // A base64 logo must never reach a cell: Sheets caps a cell at 50,000 chars.
    logoDataUrl: `data:image/png;base64,${'A'.repeat(60_000)}`,
    primaryColor: '#111', secondaryColor: '#222', companyInfo: 'info', pdfFooter: 'footer',
  },
  createdAt: AT, updatedAt: AT, ...over,
});

const customer = (over: Partial<Customer> = {}): Customer => ({
  id: 'cu1', clientId: 'c1', code: 'DOEX',
  persons: [{ given: 'Jane', family: 'Doe' }],
  archivedAt: null,
  email: 'jane@example.com', phone: '555', externalId: 'X1', notes: 'note',
  createdAt: AT, updatedAt: AT, ...over,
});

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: 't1', customerId: 'cu1', ticketId: 'TXDOEX0001', title: 'Do the thing',
  dateInitiated: '2026-07-01', status: 'In Progress', dateLastUpdated: '2026-07-20',
  waitingOn: '', waitingSince: '', summary: 'summary', nextAction: 'next',
  progressLog: [{ date: '2026-07-02', update: 'Started.' }, { date: '2026-07-20', update: 'Chased.' }],
  commRefs: [], createdAt: AT, updatedAt: AT, ...over,
});

const data = (over: Partial<MirrorData> = {}): MirrorData => ({
  clients: [client()], customers: [customer()], tickets: [ticket()], ...over,
});

const tabNamed = (title: string, d = data()) => {
  const t = mirrorTabs(d, AT).find((x) => x.title === title);
  if (!t) throw new Error(`no tab ${title}`);
  return t;
};

test('every tab leads with the banner, then the header', () => {
  const tabs = mirrorTabs(data(), AT);
  expect(tabs.map((t) => t.title)).toEqual([...TAB_TITLES]);
  for (const tab of tabs) {
    expect(tab.rows[0][0]).toContain('STEWARD mirror');
    expect(tab.rows[0][0]).toContain(AT); // a stale mirror that looks live is the other lie
    expect(tab.rows[1]).toEqual(headersFor(tab.title as never));
  }
});

// 0011 — the banner used to say "edits made here are lost", full stop. That was true while
// the mirror only wrote; the day a pull exists it is false for most of the file and still
// true for the rest, and only naming both halves is honest.
test('the banner distinguishes the two kinds of column, and Progress says it is different', () => {
  const tabs = mirrorTabs(data(), AT, '2026-08-06T09:00:00.000Z');
  const banner = (title: string) => String(tabs.find((t) => t.title === title)!.rows[0][0]);

  for (const title of ['Clients', 'Customers', 'Tickets']) {
    expect(banner(title)).toContain('The white columns are read back');
    expect(banner(title)).toContain('Column A is the record id');
    expect(banner(title)).toContain('Last pulled: 2026-08-06T09:00:00.000Z');
    expect(banner(title)).not.toContain('edits made here are lost');
  }
  expect(banner('Progress')).toContain('never read back');
  expect(banner('Progress')).not.toContain('white columns');
  // Never pulled is stated, not left blank — a missing stamp reads as an unfinished sentence.
  expect(String(mirrorTabs(data(), AT)[0].rows[0][0])).toContain('Last pulled: never');
});

// The four person columns exist because "Family, Given and Family, Given" is not
// invertible, and a CRM whose spreadsheet is the source of truth but cannot fix a
// misspelled surname is not the feature that was asked for.
test('Customers carries the readable join AND the four fields a pull can put back', () => {
  const joint = customer({ persons: [{ given: 'Gareth', family: 'Reed' }, { given: 'Emma', family: 'Claessen' }] });
  const headers = headersFor('Customers');
  const row = tabNamed('Customers', data({ customers: [joint] })).rows[2];
  const cell = (h: string) => row[headers.indexOf(h)];

  expect(cell('persons')).toBe('Reed, Gareth and Claessen, Emma');
  expect([cell('given'), cell('family')]).toEqual(['Gareth', 'Reed']);
  expect([cell('given 2'), cell('family 2')]).toEqual(['Emma', 'Claessen']);
});

test('a single customer leaves the second pair blank rather than repeating the first', () => {
  const headers = headersFor('Customers');
  const row = tabNamed('Customers').rows[2];
  expect(row[headers.indexOf('given 2')]).toBe('');
  expect(row[headers.indexOf('family 2')]).toBe('');
});

test('the grey columns are exactly the ones a pull refuses to write', () => {
  // Each of these is dangerous rather than merely useless: writing a ticket's client code
  // reads like a request to re-parent it, through a column that is not the parent's key.
  expect(derivedHeaders('Tickets')).toEqual(
    ['ticket id', 'customer', 'client code', 'last updated'],
  );
  expect(derivedHeaders('Clients')).toEqual(['code', 'archived', 'created', 'updated']);
  expect(derivedHeaders('Customers')).toEqual(
    ['client code', 'customer code', 'persons', 'archived', 'created', 'updated'],
  );
  // Nothing is both read back and computed.
  for (const tab of PULL_TABS) {
    const grey = new Set(derivedHeaders(tab));
    for (const c of PULL_COLUMNS[tab]) expect(grey.has(c.header)).toBe(false);
  }
});

test('column A is always the STEWARD id, so the sheet is joinable', () => {
  expect(tabNamed('Clients').rows[2][0]).toBe('c1');
  expect(tabNamed('Customers').rows[2][0]).toBe('cu1');
  expect(tabNamed('Tickets').rows[2][0]).toBe('t1');
});

test('the logo data URL never reaches a cell', () => {
  const flat = mirrorTabs(data(), AT).flatMap((t) => t.rows.flat()).join('|');
  expect(flat).not.toContain('data:image/png');
  expect(flat.length).toBeLessThan(5_000);
});

test('records carry the codes a reader can cross-reference, not just ids', () => {
  const customers = tabNamed('Customers').rows[2];
  expect(customers[1]).toBe('ACME'); // client code
  const tickets = tabNamed('Tickets').rows[2];
  expect(tickets[2]).toBe('Doe, Jane');
  expect(tickets[3]).toBe('ACME');
});

test('a joint customer is one row, both names in it', () => {
  const joint = customer({ persons: [{ given: 'Gareth', family: 'Reed' }, { given: 'Emma', family: 'Claessen' }] });
  const rows = tabNamed('Customers', data({ customers: [joint] })).rows;
  expect(rows.length).toBe(3);
  expect(rows[2][3]).toBe('Reed, Gareth and Claessen, Emma');
});

test('progress is its own tab, keyed by the human ticket id', () => {
  const rows = tabNamed('Progress').rows;
  expect(rows.slice(2)).toEqual([
    ['TXDOEX0001', '2026-07-02', 'Started.'],
    ['TXDOEX0001', '2026-07-20', 'Chased.'],
  ]);
});

test('a ticket whose customer is missing still renders, with blanks', () => {
  const rows = tabNamed('Tickets', data({ customers: [] })).rows;
  expect(rows[2][2]).toBe('');
  expect(rows[2][3]).toBe('');
});

test('an empty workspace is a banner and headers, and no rows', () => {
  const tabs = mirrorTabs({ clients: [], customers: [], tickets: [] }, AT);
  for (const tab of tabs) expect(tab.rows.length).toBe(2);
  expect(mirrorCounts(tabs)).toEqual({ Clients: 0, Customers: 0, Tickets: 0, Progress: 0 });
});

test('counts report data rows, not the banner and header', () => {
  expect(mirrorCounts(mirrorTabs(data(), AT))).toEqual({
    Clients: 1, Customers: 1, Tickets: 1, Progress: 2,
  });
});

// 0012 — the `active` column became `archived`, and archived rows STAY in the sheet.
// A row that vanished would be indistinguishable from one a view filtered out, and 0011
// pulls from this sheet, where a missing row already means "neither create nor delete".
test('an archived record keeps its row and carries the date', () => {
  const tabs = mirrorTabs({
    clients: [client({ archivedAt: '2026-08-04T00:00:00.000Z' })],
    customers: [customer({ archivedAt: '2026-08-04T00:00:00.000Z' })],
    tickets: [],
  }, AT);
  const named = (t: string) => tabs.find((x) => x.title === t)!;

  expect(headersFor('Clients')).toContain('archived');
  expect(headersFor('Clients')).not.toContain('active');
  expect(headersFor('Customers')).toContain('archived');

  expect(named('Clients').rows).toHaveLength(3); // banner, header, the archived row
  expect(named('Clients').rows[2][3]).toBe('2026-08-04T00:00:00.000Z');
  expect(named('Customers').rows[2][headersFor('Customers').indexOf('archived')])
    .toBe('2026-08-04T00:00:00.000Z');
});

test('a live record leaves the archived cell blank rather than saying "no"', () => {
  const tabs = mirrorTabs({ clients: [client()], customers: [], tickets: [] }, AT);
  expect(tabs.find((t) => t.title === 'Clients')!.rows[2][3]).toBe('');
});
