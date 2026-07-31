import { test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { setDb } from '../repo/db.ts';
import { sqliteRepositories } from '../repo/sqlite.ts';
import { makeServices } from '../services/index.ts';
import { dispatchSteward, isStewardAction } from './steward.ts';

function ctx() {
  setDb(new Database(':memory:'));
  const services = makeServices(sqliteRepositories());
  const client = services.createClient(
    { name: 'Acme', code: 'acme', active: true,
      branding: { logoDataUrl: null, primaryColor: '#000', secondaryColor: '#111', companyInfo: '', pdfFooter: '' } },
    'human',
  );
  return { services, clientId: client.id };
}

beforeEach(() => setDb(new Database(':memory:')));

test('isStewardAction guards the vocabulary', () => {
  expect(isStewardAction('customer.create')).toBe(true);
  expect(isStewardAction('demo.run')).toBe(false);
});

test('customer.create writes an audited row and returns an append op', () => {
  const { services, clientId } = ctx();
  const r = dispatchSteward(services, {
    action: 'customer.create', actor: 'human', session: 's',
    payload: { clientId, given: 'Jane', family: 'Doe', email: 'j@example.com' },
  });
  expect(r.ok).toBe(true);
  expect(r.ops[0]!.op).toBe('append');
  expect(r.ops[0]!.target).toBe('customer-list');
  expect(services.repos.customers.list().length).toBe(1);
  expect(services.repos.audit.recent().some((a) => a.entity === 'customer' && a.action === 'create')).toBe(true);
});

test('customer.create supports joint households', () => {
  const { services, clientId } = ctx();
  const r = dispatchSteward(services, {
    action: 'customer.create', actor: 'human', session: 's',
    payload: { clientId, given: 'Alex', family: 'Rivera', given2: 'Sam', family2: 'Rivera' },
  });
  expect(r.ok).toBe(true);
  expect(services.repos.customers.list()[0]!.persons.length).toBe(2);
});

test('missing required field returns a validation error, no write', () => {
  const { services, clientId } = ctx();
  const r = dispatchSteward(services, {
    action: 'customer.create', actor: 'human', session: 's',
    payload: { clientId, given: 'Jane' }, // no family
  });
  expect(r.ok).toBe(false);
  expect(r.error).toContain('family');
  expect(services.repos.customers.list().length).toBe(0);
});

test('customer.update replaces the row surface', () => {
  const { services, clientId } = ctx();
  const created = dispatchSteward(services, {
    action: 'customer.create', actor: 'human', session: 's',
    payload: { clientId, given: 'Jane', family: 'Doe' },
  });
  const id = (created.data as { id: string }).id;
  const r = dispatchSteward(services, {
    action: 'customer.update', actor: 'human', session: 's',
    payload: { id, given: 'Janet', family: 'Doe', email: 'janet@example.com' },
  });
  expect(r.ok).toBe(true);
  expect(r.ops[0]!.op).toBe('replace');
  expect(r.ops[0]!.target).toBe(`customer:${id}`);
  expect(services.repos.customers.get(id)!.email).toBe('janet@example.com');
});

test('client.create stores branding and returns an append op', () => {
  const { services } = ctx();
  const r = dispatchSteward(services, {
    action: 'client.create', actor: 'human', session: 's',
    payload: { name: 'Northwind', code: 'nw', primaryColor: '#324a7d' },
  });
  expect(r.ok).toBe(true);
  expect(r.ops[0]!.target).toBe('client-list');
  expect(services.repos.clients.list().some((c) => c.branding.primaryColor === '#324a7d')).toBe(true);
});

// --- tickets ---------------------------------------------------------------

function withCustomer() {
  const { services, clientId } = ctx();
  const created = dispatchSteward(services, {
    action: 'customer.create', actor: 'human', session: 's',
    payload: { clientId, given: 'Jane', family: 'Doe' },
  });
  return { services, customerId: (created.data as { id: string }).id };
}

test('ticket.create appends a card to its status column with a derived ticketId', () => {
  const { services, customerId } = withCustomer();
  const r = dispatchSteward(services, {
    action: 'ticket.create', actor: 'human', session: 's',
    payload: { customerId, title: 'Annual Review' },
  });
  expect(r.ok).toBe(true);
  expect(r.ops[0]!.op).toBe('append');
  expect(r.ops[0]!.target).toBe('ticket-col:Not Commenced');
  const t = services.repos.tickets.list()[0]!;
  expect(t.ticketId).toBe('TXDOEX0001');
  expect(services.repos.audit.recent().some((a) => a.entity === 'ticket' && a.action === 'create')).toBe(true);
});

test('ticket.create requires a title', () => {
  const { services, customerId } = withCustomer();
  const r = dispatchSteward(services, {
    action: 'ticket.create', actor: 'human', session: 's',
    payload: { customerId }, // no title
  });
  expect(r.ok).toBe(false);
  expect(r.error).toContain('title');
  expect(services.repos.tickets.list().length).toBe(0);
});

test('ticket.status moves the card (remove + append + flash) and persists', () => {
  const { services, customerId } = withCustomer();
  const created = dispatchSteward(services, {
    action: 'ticket.create', actor: 'human', session: 's',
    payload: { customerId, title: 'Review' },
  });
  const id = (created.data as { id: string }).id;
  const r = dispatchSteward(services, {
    action: 'ticket.status', actor: 'human', session: 's',
    payload: { id, status: 'In Progress' },
  });
  expect(r.ok).toBe(true);
  expect(r.ops.map((o) => o.op)).toEqual(['remove', 'append', 'flash']);
  expect(r.ops[1]!.target).toBe('ticket-col:In Progress');
  expect(services.repos.tickets.get(id)!.status).toBe('In Progress');
});

test('ticket.status rejects an unknown status, no write', () => {
  const { services, customerId } = withCustomer();
  const created = dispatchSteward(services, {
    action: 'ticket.create', actor: 'human', session: 's',
    payload: { customerId, title: 'Review' },
  });
  const id = (created.data as { id: string }).id;
  const r = dispatchSteward(services, {
    action: 'ticket.status', actor: 'human', session: 's',
    payload: { id, status: 'Bogus' },
  });
  expect(r.ok).toBe(false);
  expect(r.error).toContain('invalid status');
  expect(services.repos.tickets.get(id)!.status).toBe('Not Commenced');
});

test('ticket.progress appends a dated entry and grows the log', () => {
  const { services, customerId } = withCustomer();
  const created = dispatchSteward(services, {
    action: 'ticket.create', actor: 'human', session: 's',
    payload: { customerId, title: 'Review' },
  });
  const id = (created.data as { id: string }).id;
  const r = dispatchSteward(services, {
    action: 'ticket.progress', actor: 'human', session: 's',
    payload: { id, update: 'Called client, left message.' },
  });
  expect(r.ok).toBe(true);
  expect(r.ops[0]!.target).toBe(`ticket-progress:${id}`);
  const log = services.repos.tickets.get(id)!.progressLog;
  expect(log.length).toBe(2); // creation entry + this one
  expect(log[1]!.update).toContain('left message');
});
