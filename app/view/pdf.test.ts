import { test, expect } from 'bun:test';
import { renderTicketDocument } from './pdf.ts';
import { documentPrintOptions } from './doc.ts';
import type { Client, Customer, DocumentRef, Ticket } from '../domain/types.ts';

function makeClient(over: Partial<Client['branding']> = {}): Client {
  return {
    id: 'cli_1', name: 'Acme Advisory', code: 'acme',
    branding: {
      logoDataUrl: null, primaryColor: '#1f4e5f', secondaryColor: '#c8a15a',
      companyInfo: '12 King St', pdfFooter: 'Acme · confidential', ...over,
    },
    active: true, createdAt: '', updatedAt: '',
  };
}

const customer: Customer = {
  id: 'cus_1', clientId: 'cli_1', code: 'DOEX',
  persons: [{ given: 'Jane', family: 'Doe' }],
  email: '', phone: '', externalId: '', notes: '', createdAt: '', updatedAt: '',
};

function makeTicket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: 'tkt_1', customerId: 'cus_1', ticketId: 'TXDOEX0001',
    title: 'Annual review', dateInitiated: '2026-07-01', status: 'In Progress',
    dateLastUpdated: '2026-07-20', waitingOn: '', waitingSince: '',
    summary: 'Yearly portfolio review.', nextAction: 'Book meeting',
    progressLog: [{ date: '2026-07-10', update: 'Docs requested' }],
    commRefs: [], createdAt: '', updatedAt: '', ...over,
  };
}

test('emits branding as CSS custom properties (tokens, not literals)', () => {
  const html = renderTicketDocument(makeTicket(), customer, makeClient());
  expect(html).toContain('--brand-primary: #1f4e5f');
  expect(html).toContain('--brand-secondary: #c8a15a');
});

test('prints companyInfo from Client.branding', () => {
  const html = renderTicketDocument(makeTicket(), customer, makeClient());
  expect(html).toContain('12 King St');
});

// 0013 moved the footer OUT of the flow and into Chrome's footerTemplate. A
// `position: fixed` footer below the content box is overflow, and overflow is a
// second page — every short ticket used to ship a near-blank page 2.
test('the footer is not in the document body any more', () => {
  const html = renderTicketDocument(makeTicket(), customer, makeClient());
  expect(html).not.toContain('doc-foot');
  expect(html).not.toContain('Acme · confidential');
});

test('the pdfFooter rides in the print options instead, with a page number', () => {
  const opts = documentPrintOptions(makeClient());
  expect(opts.footerTemplate).toContain('Acme · confidential');
  expect(opts.footerTemplate).toContain('class="pageNumber"');
  expect(opts.footerTemplate).toContain('class="totalPages"');
  // Margins move out of @page and into the CDP call, or the templates have no box.
  expect(opts.margins?.bottom).toBeGreaterThan(0);
});

test('null logo degrades to a text wordmark', () => {
  const html = renderTicketDocument(makeTicket(), customer, makeClient({ logoDataUrl: null }));
  expect(html).toContain('class="wordmark"');
  expect(html).toContain('Acme Advisory');
  expect(html).not.toContain('<img');
});

test('logo data URL renders an <img>, no wordmark', () => {
  const html = renderTicketDocument(
    makeTicket(), customer, makeClient({ logoDataUrl: 'data:image/png;base64,AAAA' }),
  );
  expect(html).toContain('<img class="logo"');
  expect(html).toContain('data:image/png;base64,AAAA');
  expect(html).not.toContain('class="wordmark"');
});

test('escapes hostile ticket content', () => {
  const html = renderTicketDocument(
    makeTicket({ title: '<script>x</script>' }), customer, makeClient(),
  );
  expect(html).not.toContain('<script>x</script>');
  expect(html).toContain('&lt;script&gt;');
});

test('blank branding colors fall back to neutral tokens', () => {
  const html = renderTicketDocument(
    makeTicket(), customer, makeClient({ primaryColor: '', secondaryColor: '' }),
  );
  expect(html).toContain('--brand-primary: #1f2933');
  expect(html).toContain('--brand-secondary: #6b7280');
});

test('waiting block only when status is Waiting', () => {
  const shown = renderTicketDocument(
    makeTicket({ status: 'Waiting', waitingOn: 'client signature', waitingSince: '2026-07-15' }),
    customer, makeClient(),
  );
  expect(shown).toContain('client signature');
  const hidden = renderTicketDocument(
    makeTicket({ status: 'In Progress', waitingOn: 'client signature' }), customer, makeClient(),
  );
  expect(hidden).not.toContain('client signature');
});

test('two clients yield different branded docs from the same ticket', () => {
  const t = makeTicket();
  const a = renderTicketDocument(t, customer, makeClient({ primaryColor: '#1f4e5f' }));
  const b = renderTicketDocument(t, customer, makeClient({ primaryColor: '#324a7d' }));
  expect(a).not.toBe(b);
  expect(a).toContain('#1f4e5f');
  expect(b).toContain('#324a7d');
});

test('renders without a customer or client (orphan record)', () => {
  const html = renderTicketDocument(makeTicket(), null, null);
  expect(html).toContain('TXDOEX0001');
  expect(html).toContain('—');
});

// ---- 0013: the meta grid, the callout and the Documents section -------------

test('the meta line is a labelled grid, and the status is a pill', () => {
  const html = renderTicketDocument(makeTicket(), customer, makeClient());
  expect(html).toContain('<dl class="meta">');
  expect(html).toContain('<dt>Ticket</dt>');
  expect(html).toContain('<span class="pill">In Progress</span>');
  expect(html).toContain('1 Jul 2026'); // dates are read, not ISO
});

// The approved mockup's grid had four cells and dropped this one; the human asked
// for it back on 2026-08-04, so the grid is five wide.
test('the meta grid carries Updated as a fifth cell', () => {
  const html = renderTicketDocument(
    makeTicket({ dateLastUpdated: '2026-07-20' }), customer, makeClient(),
  );
  expect(html).toContain('<dt>Updated</dt>');
  expect(html).toContain('20 Jul 2026');
  expect(html).toContain('repeat(5, 1fr)');
});

test('Waiting gets the pill AND the callout, aged in days', () => {
  const html = renderTicketDocument(
    makeTicket({ status: 'Waiting', waitingOn: 'Client', waitingSince: '2026-07-01' }),
    customer, makeClient(), [], '2026-07-08',
  );
  expect(html).toContain('pill is-waiting');
  expect(html).toContain('class="callout"');
  expect(html).toContain('since 1 Jul 2026 · 7 days');
});

const doc = (over: Partial<DocumentRef> = {}): DocumentRef => ({
  id: 'doc_1', entity: 'ticket', entityId: 'tkt_1', name: 'Authority form.pdf',
  mimeType: 'application/pdf', size: 100, source: 'upload', storage: 'drive',
  storageId: 'x', webViewLink: 'https://drive.google.com/file/d/x/view',
  createdAt: '2026-07-29', createdBy: 'human', ...over,
});

test('the Documents section carries the Drive link', () => {
  const html = renderTicketDocument(makeTicket(), customer, makeClient(), [doc()]);
  expect(html).toContain('<h2>Documents</h2>');
  expect(html).toContain('https://drive.google.com/file/d/x/view');
  expect(html).toContain('Uploaded');
});

test('no documents means no Documents section at all', () => {
  expect(renderTicketDocument(makeTicket(), customer, makeClient(), []))
    .not.toContain('<h2>Documents</h2>');
});

test('a locally stored document prints as text, not as a dead link', () => {
  const html = renderTicketDocument(
    makeTicket(), customer, makeClient(), [doc({ storage: 'local', webViewLink: '' })],
  );
  expect(html).toContain('Authority form.pdf');
  expect(html).not.toContain('<a class="doclink"');
});
