// 0012 — archive instead of delete, and the descent rule that makes restore honest.
//
// The interesting cases are all about a record NOT being stamped: a client's customers
// leave the lists with it and come back exactly as they were, including one that was
// already archived on its own. Stamping descendants cannot do that, which is the whole
// reason visibility is a lineage question answered in SQL.

import { test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { setDb } from './db.ts';
import { sqliteRepositories } from './sqlite.ts';
import { makeServices } from '../services/index.ts';
import { dispatchSteward } from '../actions/steward.ts';

const branding = {
  logoDataUrl: null, primaryColor: '#000', secondaryColor: '#111', companyInfo: '', pdfFooter: '',
};

function workspace() {
  setDb(new Database(':memory:'));
  const s = makeServices(sqliteRepositories());
  const client = s.createClient({ name: 'Acme', code: 'acme', branding }, 'human');
  const other = s.createClient({ name: 'Beta', code: 'beta', branding }, 'human');
  const jane = s.createCustomer({ clientId: client.id, code: '', persons: [{ given: 'Jane', family: 'Doe' }],
    email: 'jane@example.com', phone: '', externalId: '', notes: '' }, 'human');
  const sam = s.createCustomer({ clientId: client.id, code: '', persons: [{ given: 'Sam', family: 'Roe' }],
    email: '', phone: '', externalId: '', notes: '' }, 'human');
  const ticket = s.createTicket({ customerId: jane.id, title: 'A', dateInitiated: '', status: 'In Progress',
    dateLastUpdated: '', waitingOn: '', waitingSince: '', summary: '', nextAction: '',
    progressLog: [], commRefs: [] }, 'human');
  return { s, client, other, jane, sam, ticket };
}

beforeEach(() => { setDb(new Database(':memory:')); });

test('a new record is live, and nothing is born archived', () => {
  const { client, jane } = workspace();
  expect(client.archivedAt).toBeNull();
  expect(jane.archivedAt).toBeNull();
});

test('archiving a customer hides it and its tickets, and nothing else', () => {
  const { s, jane, sam } = workspace();
  s.setCustomerArchived(jane.id, '2026-08-04T00:00:00.000Z', 'human');

  expect(s.repos.customers.list().map((c) => c.id)).toEqual([sam.id]);
  expect(s.repos.tickets.list()).toHaveLength(0);
  // Addressable, always: old digests and old PDFs link straight here.
  expect(s.repos.customers.get(jane.id)?.archivedAt).toBe('2026-08-04T00:00:00.000Z');
});

test('archiving a client hides its customers and tickets WITHOUT stamping them', () => {
  const { s, client, other, jane } = workspace();
  s.setClientArchived(client.id, '2026-08-04T00:00:00.000Z', 'human');

  expect(s.repos.clients.list().map((c) => c.id)).toEqual([other.id]);
  expect(s.repos.customers.list()).toHaveLength(0);
  expect(s.repos.tickets.list()).toHaveLength(0);
  // The children are hidden by descent, not by a flag of their own.
  expect(s.repos.customers.get(jane.id)?.archivedAt).toBeNull();
});

test('restoring a client leaves a separately archived customer archived', () => {
  const { s, client, jane, sam } = workspace();
  s.setCustomerArchived(jane.id, '2026-08-01T00:00:00.000Z', 'human'); // archived on her own, first
  s.setClientArchived(client.id, '2026-08-04T00:00:00.000Z', 'human');
  s.setClientArchived(client.id, null, 'human');

  expect(s.repos.clients.list().map((c) => c.id)).toContain(client.id);
  expect(s.repos.customers.list().map((c) => c.id)).toEqual([sam.id]);
  expect(s.repos.customers.get(jane.id)?.archivedAt).toBe('2026-08-01T00:00:00.000Z');
});

test('search does not return archived customers, and the archived scope returns only them', () => {
  const { s, jane } = workspace();
  expect(s.searchCustomers('jane')).toHaveLength(1);
  s.setCustomerArchived(jane.id, '2026-08-04T00:00:00.000Z', 'human');
  expect(s.searchCustomers('jane')).toHaveLength(0);
  expect(s.repos.customers.list(undefined, 'archived').map((c) => c.id)).toEqual([jane.id]);
  expect(s.repos.customers.list(undefined, 'all')).toHaveLength(2);
});

test('archive and restore write their own audit actions, with a one-key diff', () => {
  const { s, jane } = workspace();
  s.setCustomerArchived(jane.id, '2026-08-04T00:00:00.000Z', 'human');
  s.setCustomerArchived(jane.id, null, 'ai');

  // Order is not asserted: `forEntity` sorts by timestamp, and two writes in the same
  // millisecond tie. What matters is that both verbs exist as themselves rather than as
  // an `update`, and that the diff is one key — this table is append-only.
  const rows = s.repos.audit.forEntity('customer', jane.id);
  expect(rows.map((r) => r.action).sort()).toEqual(['archive', 'create', 'restore']);
  const archived = rows.find((r) => r.action === 'archive');
  const restored = rows.find((r) => r.action === 'restore');
  expect(JSON.parse(archived!.diff)).toEqual({ archivedAt: '2026-08-04T00:00:00.000Z' });
  expect(JSON.parse(restored!.diff)).toEqual({ archivedAt: null });
  expect(restored!.actor).toBe('ai');
});

test('the impact count reads the descendants rather than guessing', () => {
  const { s, client, jane } = workspace();
  expect(s.archiveImpact('client', client.id)).toEqual({ customers: 2, tickets: 1 });
  expect(s.archiveImpact('customer', jane.id)).toEqual({ customers: 0, tickets: 1 });
});

// --- the verbs through the door -------------------------------------------------

test('customer.archive takes the row out of the list and says what went with it', async () => {
  const { s, jane } = workspace();
  const r = await dispatchSteward(s, { action: 'customer.archive', payload: { id: jane.id }, actor: 'human', session: 'x' });
  expect(r.ok).toBe(true);
  expect(r.ops[0]).toMatchObject({ target: `customer:${jane.id}`, op: 'remove' });
  expect(r.reply).toContain('1 ticket went with it');
  expect(r.reply).toContain('restored');
  expect(s.repos.customers.list()).toHaveLength(1);
});

test('customer.restore puts it back', async () => {
  const { s, jane } = workspace();
  await dispatchSteward(s, { action: 'customer.archive', payload: { id: jane.id }, actor: 'human', session: 'x' });
  const r = await dispatchSteward(s, { action: 'customer.restore', payload: { id: jane.id }, actor: 'human', session: 'x' });
  expect(r.ok).toBe(true);
  expect(r.ops[0]).toMatchObject({ target: 'customer-list', op: 'append' });
  expect(s.repos.customers.list()).toHaveLength(2);
});

test('a Drive failure is reported and does NOT undo the archive', async () => {
  const { s, jane } = workspace();
  const r = await dispatchSteward(
    s,
    { action: 'customer.archive', payload: { id: jane.id }, actor: 'human', session: 'x' },
    { moveArchivedFiles: () => Promise.reject(new Error('drive is on fire')) },
  );
  expect(r.ok).toBe(true);
  expect(r.reply).toContain('Drive was not updated: drive is on fire');
  expect(s.repos.customers.get(jane.id)?.archivedAt).not.toBeNull();
});

test('archiving without Google configured says nothing about Drive at all', async () => {
  const { s, jane } = workspace();
  const r = await dispatchSteward(s, { action: 'customer.archive', payload: { id: jane.id }, actor: 'human', session: 'x' });
  expect(r.reply).not.toContain('Drive');
});
