import { test, expect } from 'bun:test';
import { headersFor, mirrorCounts, mirrorTabs, TAB_TITLES, type MirrorData } from './mirror.ts';
import type { Client, Customer, Ticket } from '../domain/types.ts';

const AT = '2026-08-01T10:00:00.000Z';

const client = (over: Partial<Client> = {}): Client => ({
  id: 'c1', name: 'Acme', code: 'ACME', active: true,
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
    expect(tab.rows[0][0]).toContain('edits made here are lost');
    expect(tab.rows[0][0]).toContain(AT); // a stale mirror that looks live is the other lie
    expect(tab.rows[1]).toEqual(headersFor(tab.title as never));
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
