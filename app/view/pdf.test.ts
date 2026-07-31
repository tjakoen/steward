import { test, expect } from 'bun:test';
import { renderTicketDocument } from './pdf.ts';
import type { Client, Customer, Ticket } from '../domain/types.ts';

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

test('prints the pdfFooter and companyInfo from Client.branding', () => {
  const html = renderTicketDocument(makeTicket(), customer, makeClient());
  expect(html).toContain('Acme · confidential');
  expect(html).toContain('12 King St');
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
