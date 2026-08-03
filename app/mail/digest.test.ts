import { test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { setDb } from '../repo/db.ts';
import { sqliteRepositories } from '../repo/sqlite.ts';
import { makeServices } from '../services/index.ts';
import type { Repositories } from '../repo/ports.ts';
import type { TicketStatus } from '../domain/types.ts';
import { buildWorkspace, KEYS, parseTime, readSettings, sendDigest, smtpConfig } from './digest.ts';

const TODAY = '2026-08-03';

beforeEach(() => { setDb(new Database(':memory:')); });

const branding = { logoDataUrl: null, primaryColor: '#1f4e5f', secondaryColor: '#c8a15a',
  companyInfo: '', pdfFooter: 'confidential' };

/** A workspace with two clients and whatever tickets a test asks for. */
function seed(spec: { client: string; status: TicketStatus }[]) {
  const repos: Repositories = sqliteRepositories();
  const s = makeServices(repos);
  const clients = new Map<string, string>();
  for (const name of new Set(spec.map((x) => x.client))) {
    const c = s.createClient({ name, code: name.toLowerCase(), active: true, branding }, 'human');
    clients.set(name, c.id);
    const cust = s.createCustomer({ clientId: c.id, code: '', persons: [{ given: 'A', family: name }],
      email: '', phone: '', externalId: '', notes: '' }, 'human');
    clients.set(`${name}:customer`, cust.id);
  }
  const tickets = spec.map((x, i) => s.createTicket({
    customerId: clients.get(`${x.client}:customer`)!, title: `Work ${i}`,
    dateInitiated: '2026-07-27', status: x.status, dateLastUpdated: '2026-08-01',
    waitingOn: x.status === 'Waiting' ? 'Client' : '', waitingSince: x.status === 'Waiting' ? '2026-07-27' : '',
    summary: '', nextAction: '', progressLog: [], commRefs: [],
  }, 'human'));
  return { repos, services: s, clients, tickets };
}

test('the workspace holds only clients with pending work', () => {
  const { repos } = seed([
    { client: 'Acme', status: 'Waiting' },
    { client: 'Acme', status: 'Completed' },
    { client: 'Northwind', status: 'Completed' },
  ]);
  const w = buildWorkspace(repos, TODAY);
  expect(w.digests.map((d) => d.client.name)).toEqual(['Acme']);
  expect(w.digests[0].total).toBe(1);
  expect(w.ticketTotal).toBe(3);
});

test('a workspace with nothing pending yields no digests at all', () => {
  const { repos } = seed([{ client: 'Acme', status: 'Completed' }]);
  expect(buildWorkspace(repos, TODAY).digests).toEqual([]);
});

test('every pending ticket carries the documents filed against it', () => {
  const { repos, services, tickets } = seed([{ client: 'Acme', status: 'Waiting' }]);
  repos.documents.create({
    entity: 'ticket', entityId: tickets[0].id, name: 'Authority.pdf', mimeType: 'application/pdf',
    size: 1, source: 'upload', storage: 'drive', storageId: 'x',
    webViewLink: 'https://drive.google.com/file/d/x/view', createdBy: 'human',
  });
  void services;
  const w = buildWorkspace(repos, TODAY);
  expect(w.digests[0].groups[0].items[0].documents).toHaveLength(1);
});

test('the documents of every pending ticket are ONE query, not one per ticket', () => {
  const { repos } = seed(Array.from({ length: 5 }, () => ({ client: 'Acme', status: 'Waiting' as TicketStatus })));
  let reads = 0;
  const counted: Repositories = {
    ...repos,
    documents: { ...repos.documents, forEntities: (e, ids) => { reads++; return repos.documents.forEntities(e, ids); } },
  };
  buildWorkspace(counted, TODAY);
  expect(reads).toBe(1);
});

// ---- sending ----------------------------------------------------------------

const okSend = () => Promise.resolve({ ok: true });

/** Enough for `sendDigest` to get past its own configuration check. */
function configure(repos: Repositories) {
  repos.settings.set(KEYS.to, 'admin@example.com');
  repos.settings.set(KEYS.host, 'smtp.example.com');
  repos.settings.set(KEYS.user, 'me@example.com');
  repos.settings.set(KEYS.password, 'app-password');
}

test('an unconfigured send renders nothing at all before giving up', async () => {
  const { repos } = seed([{ client: 'Acme', status: 'Waiting' }]);
  let rendered = 0;
  const out = await sendDigest({
    repos,
    print: async () => { rendered++; return new Uint8Array([1]); },
    send: async () => { throw new Error('should never be dialled'); },
  }, TODAY);
  expect(out.ok).toBe(false);
  expect(out.error).toContain('no host, user, password, recipient');
  expect(rendered).toBe(0);
});

test('one email carries one attachment per client with pending work', async () => {
  const { repos } = seed([
    { client: 'Acme', status: 'Waiting' },
    { client: 'Northwind', status: 'In Progress' },
    { client: 'Quiet', status: 'Completed' },
  ]);
  configure(repos);
  let sent: { to: string; subject: string; attachments?: { filename: string }[] } | null = null;
  const out = await sendDigest({
    repos,
    print: async () => new Uint8Array([1, 2, 3]),
    send: async (_c, msg) => { sent = msg; return { ok: true }; },
  }, TODAY);

  expect(out.ok).toBe(true);
  expect(out.attachments).toBe(2);
  expect(sent!.to).toBe('admin@example.com');
  expect(sent!.subject).toBe('STEWARD — 2 pending tickets, 3 August 2026');
  expect(sent!.attachments!.map((a) => a.filename))
    .toEqual(['Acme — pending 2026-08-03.pdf', 'Northwind — pending 2026-08-03.pdf']);
});

test('an empty workspace still sends, with no attachments', async () => {
  const { repos } = seed([{ client: 'Acme', status: 'Completed' }]);
  configure(repos);
  let text = '';
  const out = await sendDigest({
    repos,
    print: async () => { throw new Error('nothing should be rendered'); },
    send: async (_c, msg) => { text = msg.text; return { ok: true }; },
  }, TODAY);
  expect(out.ok).toBe(true);
  expect(out.attachments).toBe(0);
  expect(text).toContain('Nothing is pending this morning.');
});

test('one client failing to render does not cost the others their report', async () => {
  const { repos } = seed([
    { client: 'Acme', status: 'Waiting' },
    { client: 'Northwind', status: 'Waiting' },
  ]);
  configure(repos);
  let first = true;
  const out = await sendDigest({
    repos,
    print: async () => { if (first) { first = false; throw new Error('chrome died'); } return new Uint8Array([1]); },
    send: okSend,
    log: () => {},
  }, TODAY);
  expect(out.ok).toBe(true);
  expect(out.attachments).toBe(1);
  expect(out.tickets).toBe(2); // the body still counts what did not render
});

test('a successful send audits against every client whose work went out', async () => {
  const { repos } = seed([{ client: 'Acme', status: 'Waiting' }]);
  configure(repos);
  const audited: { clientId: string; recipient: string }[] = [];
  await sendDigest({
    repos, print: async () => new Uint8Array([1]), send: okSend,
    audit: (clientId, recipient) => audited.push({ clientId, recipient }),
  }, TODAY);
  expect(audited).toHaveLength(1);
  expect(audited[0].recipient).toBe('admin@example.com');
});

test('a failed send audits nothing — it did not happen', async () => {
  const { repos } = seed([{ client: 'Acme', status: 'Waiting' }]);
  configure(repos);
  const audited: unknown[] = [];
  const out = await sendDigest({
    repos, print: async () => new Uint8Array([1]),
    send: async () => ({ ok: false, error: 'no route to host' }),
    audit: () => audited.push(1),
  }, TODAY);
  expect(out.ok).toBe(false);
  expect(out.error).toBe('no route to host');
  expect(audited).toHaveLength(0);
});

// ---- settings ---------------------------------------------------------------

test('a time of day is HH:MM and nothing else', () => {
  expect(parseTime('8:00')).toBe('08:00');
  expect(parseTime('23:59')).toBe('23:59');
  expect(parseTime('24:00')).toBe(null);
  expect(parseTime('08:60')).toBe(null);
  expect(parseTime('morning')).toBe(null);
});

test('the settings never carry the password back out, only whether one exists', () => {
  const { repos } = seed([]);
  repos.settings.set(KEYS.password, 'app-password');
  const read = readSettings(repos.settings);
  expect(read.hasPassword).toBe(true);
  expect(JSON.stringify(read)).not.toContain('app-password');
  // The one place it IS handed over is the transport, and only there.
  expect(smtpConfig(repos.settings).password).toBe('app-password');
});

test('an empty From falls back to the account that authenticates', () => {
  const { repos } = seed([]);
  repos.settings.set(KEYS.user, 'me@example.com');
  expect(readSettings(repos.settings).from).toBe('me@example.com');
});
