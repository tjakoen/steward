// 0014 — the repository reads that turned into queries, and the audit read that turned
// "Showing 3 of 200" from a wrong answer into a true one.
//
// The interesting cases are the ones a type checker cannot see: that an EMPTY facet means
// "no filter" rather than "matches nothing", that `q` searches the columns the list shows
// (so the server's filter and the browser's agree), and that the audit LIMIT is applied
// after the predicate rather than before it — which is the whole bug.

import { test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { db, setDb } from './db.ts';
import { sqliteRepositories } from './sqlite.ts';
import { makeServices } from '../services/index.ts';

const branding = {
  logoDataUrl: null, primaryColor: '#000', secondaryColor: '#111',
  companyInfo: 'Level 4, Bridge Street', pdfFooter: '',
};

function workspace() {
  setDb(new Database(':memory:'));
  const s = makeServices(sqliteRepositories());
  const acme = s.createClient({ name: 'Acme Advisory', code: 'acme', branding }, 'human');
  const beta = s.createClient({ name: 'Beta Group', code: 'beta',
    branding: { ...branding, companyInfo: 'Unit 9, Quay Road' } }, 'human');
  const jane = s.createCustomer({ clientId: acme.id, code: '', persons: [{ given: 'Jane', family: 'Doe' }],
    email: 'jane@example.com', phone: '', externalId: '', notes: '' }, 'human');
  const sam = s.createCustomer({ clientId: beta.id, code: '', persons: [{ given: 'Sam', family: 'Roe' }],
    email: 'sam@example.com', phone: '', externalId: '', notes: '' }, 'human');
  const ticket = (customerId: string, title: string, status: 'Waiting' | 'In Progress' | 'Completed') =>
    s.createTicket({ customerId, title, dateInitiated: '', status, dateLastUpdated: '',
      waitingOn: '', waitingSince: '', summary: '', nextAction: '',
      progressLog: [], commRefs: [] }, 'human');
  const t1 = ticket(jane.id, 'Annual review', 'Waiting');
  const t2 = ticket(jane.id, 'Rollover', 'In Progress');
  const t3 = ticket(sam.id, 'Annual review', 'Waiting');
  return { s, acme, beta, jane, sam, t1, t2, t3 };
}

beforeEach(() => { setDb(new Database(':memory:')); });

// ---- "no filter" is not "matches nothing" ----------------------------------

test('an absent or empty facet narrows nothing', () => {
  const { s } = workspace();
  const all = s.repos.tickets.list().length;
  expect(s.repos.tickets.list({}).length).toBe(all);
  // An unchecked chip group posts no values at all. If that were read as `status IN ()`
  // every list would come back empty the moment a facet bar was rendered.
  expect(s.repos.tickets.list({ status: [] }).length).toBe(all);
  expect(s.repos.tickets.list({ q: '   ' }).length).toBe(all);
  expect(s.repos.clients.list({ q: '' }).length).toBe(2);
});

test('the default is still live, exactly as 0012 left it', () => {
  const { s, jane } = workspace();
  s.setCustomerArchived(jane.id, '2026-08-04T00:00:00.000Z', 'human');
  expect(s.repos.customers.list().map((c) => c.code)).toEqual(['ROEX']);
  expect(s.repos.customers.list({ scope: 'archived' }).map((c) => c.code)).toEqual(['DOEX']);
  expect(s.repos.customers.list({ scope: 'all' })).toHaveLength(2);
  // Tickets are hidden by their customer's lineage, not by a flag of their own.
  expect(s.repos.tickets.list()).toHaveLength(1);
  expect(s.repos.tickets.list({ scope: 'all' })).toHaveLength(3);
});

// ---- the facets ------------------------------------------------------------

test('status is multi-select, and the values are OR-ed within the facet', () => {
  const { s } = workspace();
  expect(s.repos.tickets.list({ status: ['Waiting'] })).toHaveLength(2);
  expect(s.repos.tickets.list({ status: ['Waiting', 'In Progress'] })).toHaveLength(3);
  expect(s.repos.tickets.list({ status: ['Completed'] })).toHaveLength(0);
});

test('facets from different groups are AND-ed', () => {
  const { s, jane } = workspace();
  const got = s.repos.tickets.list({ status: ['Waiting'], customerId: jane.id });
  expect(got.map((t) => t.title)).toEqual(['Annual review']);
});

test('a ticket can be filtered by its CLIENT, through the join that was already there', () => {
  const { s, acme, beta } = workspace();
  expect(s.repos.tickets.list({ clientId: acme.id })).toHaveLength(2);
  expect(s.repos.tickets.list({ clientId: beta.id })).toHaveLength(1);
});

test('byStatus takes the same query as list, so the board and the counts agree', () => {
  const { s, acme } = workspace();
  const board = s.repos.tickets.byStatus({ clientId: acme.id });
  expect((board['Waiting'] ?? []).length).toBe(1);
  expect((board['In Progress'] ?? []).length).toBe(1);
  // It used to take no argument and call `this.list()`, which was right only while the
  // default scope was live — an archived view would have shown a board of everything.
  const jane = s.repos.customers.list({ clientId: acme.id })[0]!;
  s.setCustomerArchived(jane.id, '2026-08-04T00:00:00.000Z', 'human');
  expect(Object.values(s.repos.tickets.byStatus()).flat()).toHaveLength(1);
  expect(Object.values(s.repos.tickets.byStatus({ scope: 'all' })).flat()).toHaveLength(3);
});

// ---- q, and the columns it has to agree with -------------------------------

test('q is case-insensitive and matches the columns each list SHOWS', () => {
  const { s } = workspace();
  // The client list shows name, code and company info — all three are searchable, or
  // typing the same word into the box and into the URL would give two different answers.
  expect(s.repos.clients.list({ q: 'ACME' }).map((c) => c.code)).toEqual(['acme']);
  expect(s.repos.clients.list({ q: 'quay' }).map((c) => c.code)).toEqual(['beta']);
  expect(s.repos.clients.list({ q: 'bridge' }).map((c) => c.code)).toEqual(['acme']);
  expect(s.repos.customers.list({ q: 'jane@' }).map((c) => c.code)).toEqual(['DOEX']);
  expect(s.repos.customers.list({ q: 'roe' }).map((c) => c.code)).toEqual(['ROEX']);
  // A ticket card shows its customer's name, so the ticket query reaches through the join.
  expect(s.repos.tickets.list({ q: 'rollover' })).toHaveLength(1);
  expect(s.repos.tickets.list({ q: 'doe' })).toHaveLength(2);
});

test('q is a value, not SQL', () => {
  const { s } = workspace();
  expect(s.repos.clients.list({ q: "' OR 1=1 --" })).toHaveLength(0);
  expect(s.repos.tickets.list({ status: ["Waiting') OR ('1'='1" ] as never })).toHaveLength(0);
});

test('search and list ask the same question, one of them capped', () => {
  const { s } = workspace();
  expect(s.repos.customers.search('jane').map((c) => c.id))
    .toEqual(s.repos.customers.list({ q: 'jane' }).map((c) => c.id));
});

// ---- documents -------------------------------------------------------------

test('files filter by source and by storage — which is why "not in Drive" is answerable', () => {
  const { s, jane } = workspace();
  s.repos.documents.create({ entity: 'customer', entityId: jane.id, name: 'a.pdf',
    mimeType: 'application/pdf', size: 10, source: 'generated', storage: 'local',
    storageId: 'x', webViewLink: '', createdBy: 'human' });
  s.repos.documents.create({ entity: 'customer', entityId: jane.id, name: 'b.png',
    mimeType: 'image/png', size: 10, source: 'upload', storage: 'drive',
    storageId: 'y', webViewLink: '', createdBy: 'human' });
  expect(s.repos.documents.list()).toHaveLength(2);
  expect(s.repos.documents.list({ storage: ['local'] }).map((d) => d.name)).toEqual(['a.pdf']);
  expect(s.repos.documents.list({ source: ['upload'] }).map((d) => d.name)).toEqual(['b.png']);
  expect(s.repos.documents.list({ source: ['upload'], storage: ['local'] })).toHaveLength(0);
  expect(s.repos.documents.list({ q: 'A.PD' }).map((d) => d.name)).toEqual(['a.pdf']);
});

// ---- the audit trail, and the cap ------------------------------------------

test('the audit limit is applied AFTER the predicate, not before it', () => {
  const { s, jane, sam } = workspace();
  // Backdated explicitly rather than by writing quickly: `at` is millisecond-resolution and
  // thirty writes in one tick would tie, which would make this a test of `ORDER BY` on
  // equal keys rather than of the cap.
  db().run(`UPDATE audit SET at = '2020-01-01T00:00:00.000Z' WHERE entityId = ?`, [jane.id]);
  for (let i = 0; i < 30; i++) s.updateCustomer(sam.id, { notes: `note ${i}` }, 'human');

  // Jane's rows are now the oldest in the trail, so a cap that bites BEFORE the predicate
  // loses them first — which is exactly how "Showing 3 of 200" came to describe the last
  // two hundred rows rather than the audit trail.
  expect(s.repos.audit.recent(5).some((e) => e.entityId === jane.id)).toBe(false);
  expect(s.repos.audit.query({ q: 'jane', limit: 5 }).some((e) => e.entityId === jane.id)).toBe(true);
  // …and the page can say how many it did not show, because the count ignores the limit.
  expect(s.repos.audit.count({ q: 'jane' })).toBeGreaterThan(0);
});

test('the audit q matches the NAME of the record a row points at', () => {
  const { s, jane, acme } = workspace();
  // The row itself stores an id and a verb. Nobody has ever searched for an id.
  expect(s.repos.audit.query({ q: 'jane' }).every((e) => e.entityId === jane.id)).toBe(true);
  expect(s.repos.audit.query({ q: 'jane' }).length).toBeGreaterThan(0);
  expect(s.repos.audit.query({ q: 'acme advisory' }).map((e) => e.entityId)).toEqual([acme.id]);
  expect(s.repos.audit.query({ q: 'annual review' }).length).toBe(2);
});

test('the audit facets: entity, action, actor and a date range', () => {
  const { s, jane } = workspace();
  s.setCustomerArchived(jane.id, '2026-08-04T00:00:00.000Z', 'ai');

  expect(s.repos.audit.query({ entity: ['ticket'] })).toHaveLength(3);
  expect(s.repos.audit.query({ action: ['archive'] })).toHaveLength(1);
  expect(s.repos.audit.query({ actor: ['ai'] }).map((e) => e.action)).toEqual(['archive']);
  expect(s.repos.audit.actors()).toEqual(['ai', 'human']);

  // Both ends of the range are inclusive — a reader of "From … To …" expects the day
  // named on each end to be in the answer.
  const today = new Date().toISOString().slice(0, 10);
  expect(s.repos.audit.query({ from: today, to: today }).length)
    .toBe(s.repos.audit.count());
  expect(s.repos.audit.query({ from: '2999-01-01' })).toHaveLength(0);
  expect(s.repos.audit.query({ to: '1999-01-01' })).toHaveLength(0);
});

test('count answers the same predicate as query, without the limit', () => {
  const { s } = workspace();
  const q = { entity: ['ticket'] as const };
  expect(s.repos.audit.count({ entity: ['ticket'] })).toBe(3);
  expect(s.repos.audit.query({ ...q, entity: ['ticket'], limit: 1 })).toHaveLength(1);
  expect(s.repos.audit.count()).toBeGreaterThan(3);
  // A row whose record has since been deleted is still history: the joins are LEFT.
  const t = s.repos.tickets.list()[0]!;
  const before = s.repos.audit.count();
  s.repos.tickets.remove(t.id);
  expect(s.repos.audit.count()).toBe(before);
});
