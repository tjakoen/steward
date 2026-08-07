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
    { name: 'Acme', code: 'acme',
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

// --- the Sheets mirror ------------------------------------------------------

test('sheet.push reports what it wrote, and emits no op at a surface it cannot see', async () => {
  const { services } = ctx();
  const r = await dispatchSteward(services, {
    action: 'sheet.push', actor: 'human', session: 's', payload: {},
  }, {
    pushSheet: async () => ({ ok: true, url: 'https://docs.google.com/x', counts: { Clients: 1, Tickets: 0 } }),
  });
  expect(r.ok).toBe(true);
  expect(r.ops).toEqual([]); // the mirror lives in Google, not on this screen
  expect(r.reply).toContain('1 clients');
});

test('sheet.push says when the mirror had to be recreated', async () => {
  const { services } = ctx();
  const r = await dispatchSteward(services, {
    action: 'sheet.push', actor: 'human', session: 's', payload: {},
  }, { pushSheet: async () => ({ ok: true, counts: {}, recreated: true }) });
  expect(r.reply).toContain('a new one was created');
});

test('sheet.push surfaces the reason a push failed', async () => {
  const { services } = ctx();
  const r = await dispatchSteward(services, {
    action: 'sheet.push', actor: 'human', session: 's', payload: {},
  }, { pushSheet: async () => ({ ok: false, reason: 'Google is not connected.' }) });
  expect(r.ok).toBe(false);
  expect(r.error).toContain('not connected');
});

test('sheet.push refuses by name when no mirror is wired up, rather than claiming success', async () => {
  const { services } = ctx();
  const r = await dispatchSteward(services, { action: 'sheet.push', actor: 'human', session: 's', payload: {} });
  expect(r.ok).toBe(false);
  expect(r.error).toContain('not configured');
});

// --- the pull previews, and only previews (0011) ----------------------------

test('sheet.pull reports the diff in words and writes nothing', async () => {
  const { services } = ctx();
  const r = await dispatchSteward(services, {
    action: 'sheet.pull', actor: 'human', session: 's', payload: {},
  }, {
    previewPull: async () => ({
      ok: true, changes: 1, records: 12, conflicts: 0, unknown: 0, blank: 0,
      problems: [], refusal: null, needsAck: false,
      lines: ['Ticket TXDOEX0001 (row 4): next action "chase" → "call back"'],
    }),
  });
  expect(r.ok).toBe(true);
  expect(r.ops).toEqual([]); // the sheet is not a surface this process can see
  expect(r.reply).toContain('1 of 12 records');
  expect(r.reply).toContain('TXDOEX0001');
  // The load-bearing sentence: an AI that could apply removes the only defence against
  // the shifted paste, so the verb has to say where applying happens instead.
  expect(r.reply).toContain('Nothing has been written');
  expect(r.reply).toContain('Settings');
});

test('sheet.pull says so plainly when the sheet and STEWARD agree', async () => {
  const { services } = ctx();
  const r = await dispatchSteward(services, {
    action: 'sheet.pull', actor: 'human', session: 's', payload: {},
  }, { previewPull: async () => ({ ok: true, changes: 0, records: 12, lines: [] }) });
  expect(r.reply).toContain('agree');
  expect(r.reply).not.toContain('Settings'); // nothing to apply, so no instruction to
});

test('sheet.pull reports the rows it skipped rather than staying quiet about them', async () => {
  const { services } = ctx();
  const r = await dispatchSteward(services, {
    action: 'sheet.pull', actor: 'human', session: 's', payload: {},
  }, {
    previewPull: async () => ({
      ok: true, changes: 2, records: 12, conflicts: 1, unknown: 3, blank: 1,
      needsAck: true, lines: ['a', 'b'],
    }),
  });
  expect(r.reply).toContain('does not know');
  expect(r.reply).toContain('no id');
  expect(r.reply).toContain("the sheet's value would win");
  expect(r.reply).toContain('second confirmation');
});

test('a refused pull is an error carrying the refusal, not a cheerful summary', async () => {
  const { services } = ctx();
  const r = await dispatchSteward(services, {
    action: 'sheet.pull', actor: 'human', session: 's', payload: {},
  }, {
    previewPull: async () => ({
      ok: true, changes: 0, records: 12,
      refusal: 'Tickets has two rows for the same record id (t_1), at Tickets!A4.',
      problems: [{ where: 'Tickets!A4', message: 'duplicate' }],
    }),
  });
  expect(r.ok).toBe(false);
  expect(r.error).toContain('two rows for the same record id');
});

test('sheet.pull refuses by name when no mirror is wired up', async () => {
  const { services } = ctx();
  const r = await dispatchSteward(services, { action: 'sheet.pull', actor: 'human', session: 's', payload: {} });
  expect(r.ok).toBe(false);
  expect(r.error).toContain('not configured');
});

test('a rejected push is an error, not an unhandled rejection', async () => {
  const { services } = ctx();
  const r = await dispatchSteward(services, {
    action: 'sheet.push', actor: 'human', session: 's', payload: {},
  }, { pushSheet: async () => { throw new Error('socket hang up'); } });
  expect(r.ok).toBe(false);
  expect(r.error).toContain('socket hang up');
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
