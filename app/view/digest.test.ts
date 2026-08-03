import { test, expect } from 'bun:test';
import {
  digestBody, digestFileName, digestFor, digestSubject, isPending,
  renderDigestDocument, type PendingTicket,
} from './digest.ts';
import type { Client, Customer, DocumentRef, Ticket, TicketStatus } from '../domain/types.ts';

const TODAY = '2026-08-03';

const client = (over: Partial<Client> = {}): Client => ({
  id: 'cli_1', name: 'Acme Advisory', code: 'acme',
  branding: { logoDataUrl: null, primaryColor: '#1f4e5f', secondaryColor: '#c8a15a',
    companyInfo: 'Acme Advisory Pty Ltd', pdfFooter: 'Acme · confidential' },
  archivedAt: null, createdAt: '', updatedAt: '', ...over,
});

const customer: Customer = {
  id: 'cus_1', clientId: 'cli_1', code: 'SMIT',
  persons: [{ given: 'John', family: 'Smith' }],
  email: '', phone: '', externalId: '', notes: '', archivedAt: null, createdAt: '', updatedAt: '',
};

function pending(over: Partial<Ticket> = {}, documents: DocumentRef[] = []): PendingTicket {
  return {
    ticket: {
      id: 'tkt_1', customerId: 'cus_1', ticketId: 'TXSMIT0001',
      title: 'Service Agreement Renewal', dateInitiated: '2026-07-27', status: 'Waiting',
      dateLastUpdated: '2026-08-01', waitingOn: 'Client', waitingSince: '2026-07-27',
      summary: '', nextAction: 'Chase signed authority.',
      progressLog: [], commRefs: [], createdAt: '', updatedAt: '', ...over,
    },
    customer,
    documents,
  };
}

const at = (status: TicketStatus, id: string, over: Partial<Ticket> = {}) =>
  pending({ status, id, ticketId: id, ...over });

test('pending is everything that is not Completed', () => {
  expect(isPending(pending({ status: 'Completed' }).ticket)).toBe(false);
  for (const s of ['Waiting', 'In Progress', 'Not Commenced'] as TicketStatus[]) {
    expect(isPending(pending({ status: s }).ticket)).toBe(true);
  }
});

test('groups run Waiting → In Progress → Not Commenced, not the enum order', () => {
  const d = digestFor(client(), [
    at('Not Commenced', 'c'), at('In Progress', 'b'), at('Waiting', 'a'),
  ], TODAY);
  expect(d.groups.map((g) => g.status)).toEqual(['Waiting', 'In Progress', 'Not Commenced']);
  expect(d.total).toBe(3);
});

test('the Waiting group is sorted oldest first, and knows its oldest', () => {
  const d = digestFor(client(), [
    at('Waiting', 'newer', { waitingSince: '2026-07-30' }),
    at('Waiting', 'older', { waitingSince: '2026-07-27' }),
  ], TODAY);
  expect(d.groups[0].items.map((p) => p.ticket.id)).toEqual(['older', 'newer']);
  expect(d.oldestWaitingDays).toBe(7);
});

test('a Waiting ticket with no waitingSince ages from when it was raised', () => {
  const d = digestFor(client(), [
    at('Waiting', 'x', { waitingSince: '', dateInitiated: '2026-08-01' }),
  ], TODAY);
  expect(d.oldestWaitingDays).toBe(2);
});

test('the report ages the Waiting group and marks a week as old', () => {
  const d = digestFor(client(), [
    at('Waiting', 'a', { waitingSince: '2026-07-27' }),
    at('Waiting', 'b', { waitingSince: '2026-08-01' }),
  ], TODAY);
  const html = renderDigestDocument(d, TODAY);
  expect(html).toContain('age is-old">7 days');
  expect(html).toContain('class="age">2 days');
});

test('the report carries the Drive links of each pending ticket', () => {
  const withDoc = pending({}, [{
    id: 'doc_1', entity: 'ticket', entityId: 'tkt_1', name: 'Authority form.pdf',
    mimeType: 'application/pdf', size: 1, source: 'upload', storage: 'drive', storageId: 'x',
    webViewLink: 'https://drive.google.com/file/d/x/view', createdAt: TODAY, createdBy: 'human',
  }]);
  const html = renderDigestDocument(digestFor(client(), [withDoc], TODAY), TODAY);
  expect(html).toContain('https://drive.google.com/file/d/x/view');
  expect(html).toContain('Authority form.pdf');
});

test('a pending ticket with no documents renders no link list', () => {
  const html = renderDigestDocument(digestFor(client(), [pending()], TODAY), TODAY);
  expect(html).not.toContain('class="links"');
});

test('the report is branded per client, never with somebody else’s colours', () => {
  const a = renderDigestDocument(digestFor(client(), [pending()], TODAY), TODAY);
  const b = renderDigestDocument(
    digestFor(client({ id: 'cli_2', name: 'Northwind', branding: { ...client().branding, primaryColor: '#324a7d' } }),
      [pending()], TODAY), TODAY);
  expect(a).toContain('--brand-primary: #1f4e5f');
  expect(b).toContain('--brand-primary: #324a7d');
});

test('a client with nothing pending renders the empty case, not a broken table', () => {
  const html = renderDigestDocument(digestFor(client(), [], TODAY), TODAY, 6);
  expect(html).toContain('Nothing is pending.');
  expect(html).toContain('All 6 tickets are completed.');
  expect(html).not.toContain('<table>');
});

test('the title carries the weekday, parsed as UTC so it is not yesterday', () => {
  const html = renderDigestDocument(digestFor(client(), [], TODAY), TODAY);
  expect(html).toContain('Pending work — Monday 3 August 2026');
});

// ---- the email --------------------------------------------------------------

test('subject counts every pending ticket across clients', () => {
  const digests = [
    digestFor(client(), [at('Waiting', 'a'), at('In Progress', 'b')], TODAY),
    digestFor(client({ id: 'cli_2', name: 'Northwind' }), [at('Waiting', 'c')], TODAY),
  ];
  expect(digestSubject(digests, TODAY)).toBe('STEWARD — 3 pending tickets, 3 August 2026');
});

test('an empty workspace still gets a subject and a body that says so', () => {
  expect(digestSubject([], TODAY)).toBe('STEWARD — nothing pending, 3 August 2026');
  const body = digestBody([], TODAY, 6);
  expect(body).toContain('Nothing is pending this morning.');
  expect(body).toContain('All 6 tickets are completed.');
  expect(body).toContain('No reports are attached.');
});

test('the body names the single oldest waiting ticket across every client', () => {
  const digests = [
    digestFor(client(), [at('Waiting', 'a', { waitingSince: '2026-08-01' })], TODAY),
    digestFor(client({ id: 'cli_2', name: 'Northwind Planning' }),
      [at('Waiting', 'b', { waitingSince: '2026-07-27', ticketId: 'TXRIVE0001', title: 'Annual Statement' })], TODAY),
  ];
  const body = digestBody(digests, TODAY);
  expect(body).toContain('The oldest is TXRIVE0001 — Annual Statement');
  expect(body).toContain('(7 days)');
  expect(body).toContain('Acme Advisory');
  expect(body).toContain('Northwind Planning');
});

test('the per-client breakdown only names groups that have something in them', () => {
  const body = digestBody([digestFor(client(), [at('Waiting', 'a'), at('Waiting', 'b')], TODAY)], TODAY);
  expect(body).toContain('(2 waiting)');
  expect(body).not.toContain('in progress');
});

test('the attachment is named for the client and the day', () => {
  expect(digestFileName(digestFor(client(), [], TODAY), TODAY))
    .toBe('Acme Advisory — pending 2026-08-03.pdf');
});
