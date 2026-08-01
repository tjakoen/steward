import { test, expect } from 'bun:test';
import {
  renderForm, customerSchema, esc, customerRow, renderBoard,
  auditTime, auditSummary, auditItem, auditList,
  fileSize, previewKind, documentChip, icon,
} from './html.ts';
import { TICKET_STATUSES } from '../domain/types.ts';
import type { AuditEntry, Client, Customer, DocumentRef, Ticket } from '../domain/types.ts';

const auditEntry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  id: 'aud_1', entity: 'customer', entityId: 'cus_1', action: 'update',
  actor: 'human', at: '2026-07-31T09:12:44.000Z', diff: '{}', ...over,
});

const client: Client = {
  id: 'cli_1', name: 'Acme', code: 'acme',
  branding: { logoDataUrl: null, primaryColor: '#111', secondaryColor: '#222', companyInfo: '', pdfFooter: '' },
  active: true, createdAt: '', updatedAt: '',
};

test('esc neutralizes HTML', () => {
  expect(esc('<script>&"')).toBe('&lt;script&gt;&amp;&quot;');
});

test('create mode renders inputs, no id, submit', () => {
  const html = renderForm(customerSchema([client]), 'create');
  expect(html).toContain('data-mode="create"');
  expect(html).toContain('<input');
  expect(html).toContain('type="submit"');
  expect(html).not.toContain('name="id"');
});

test('edit mode seeds values and carries the id', () => {
  const html = renderForm(customerSchema([client], 'customer.update'), 'edit', { id: 'cus_9', given: 'Jane', family: 'Doe' });
  expect(html).toContain('data-mode="edit"');
  expect(html).toContain('name="id"');
  expect(html).toContain('value="Jane"');
  expect(html).toContain('data-action="customer.update"');
});

test('view mode shows display fields, an edit toggle, and no text inputs', () => {
  const html = renderForm(customerSchema([client]), 'view', { given: 'Jane', family: 'Doe' });
  expect(html).toContain('data-mode="view"');
  expect(html).toContain('data-form-edit');
  expect(html).toContain('data-field-value');
  expect(html).not.toContain('type="text"');
});

test('customerRow escapes and exposes a per-row surface', () => {
  const c: Customer = {
    id: 'cus_1', clientId: 'cli_1', code: 'DOEX',
    persons: [{ given: 'Jane', family: 'Doe' }],
    email: 'j@example.com', phone: '', externalId: '', notes: '', createdAt: '', updatedAt: '',
  };
  expect(customerRow(c)).toContain('data-surface="customer:cus_1"');
  expect(customerRow(c)).toContain('Doe, Jane');
});

// ---- icons -----------------------------------------------------------------

test('icon references GRAIN\'s sprite and hides itself from the accessibility tree', () => {
  const html = icon('tasks', 'nav__ico', 'sm');
  expect(html).toContain('href="/assets/sprite.svg#tasks"');
  // GRAIN's .icon is what sizes the box; a STEWARD class rides beside it
  expect(html).toContain('class="icon nav__ico"');
  expect(html).toContain('data-size="sm"');
  expect(html).toContain('aria-hidden="true"');
});

test('every icon STEWARD names exists in the sprite it points at', async () => {
  const sprite = await Bun.file(
    new URL('../../node_modules/@tjakoen/grain/assets/sprite.svg', import.meta.url).pathname,
  ).text();
  // A misnamed glyph renders nothing at all — silently, with no error anywhere.
  for (const name of ['loop', 'rules', 'pin', 'tasks', 'files', 'traces', 'knowledge',
    'settings', 'close', 'plus', 'check'] as const) {
    expect(sprite).toContain(`id="${name}"`);
  }
});

// ---- audit trail -----------------------------------------------------------

test('auditTime renders an ISO stamp as date + minutes', () => {
  expect(auditTime('2026-07-31T09:12:44.000Z')).toBe('2026-07-31 09:12');
  expect(auditTime('nonsense')).toBe('nonsense');
});

test('auditSummary counts what changed and leaks neither values nor field names', () => {
  const e = auditEntry({ diff: JSON.stringify({ id: 'cus_1', email: 'secret@example.com', notes: 'private' }) });
  const summary = auditSummary(e);
  expect(summary).toBe('2 details changed');
  expect(summary).not.toContain('secret@example.com');
  expect(summary).not.toContain('private');
  expect(summary).not.toContain('email');
  expect(summary).not.toContain('notes');
});

test('auditSummary says what happened, in English', () => {
  const s = (diff: unknown, over: Partial<AuditEntry> = {}) =>
    auditSummary(auditEntry({ diff: JSON.stringify(diff), ...over }));
  // the ticket status is the one value kept: a published workflow state, and
  // the thing a reader of the timeline is looking for
  expect(s({ status: 'Completed' })).toBe('status set to Completed');
  expect(s({ status: 'Waiting', waitingOn: 'the council' }))
    .toBe('status set to Waiting, and 1 other detail changed');
  expect(s({ addProgress: { date: '', update: 'x' } })).toBe('progress logged');
  expect(s({ attached: 'passport.pdf', source: 'upload' })).toBe('file uploaded');
  expect(s({ attached: 'TCK-1.pdf', source: 'generated' })).toBe('document generated');
  expect(s({ linked: 'Q3 plan.docx' })).toBe('Drive file linked');
  expect(s({ removedDocument: 'passport.pdf' })).toBe('document removed');
  // a create writes every field; the row's verb already said "created"
  expect(s({ title: 'x', status: 'Not Commenced' }, { action: 'create' })).toBe('');
  expect(auditSummary(auditEntry({ diff: 'not json' }))).toBe('');
});

test('auditSummary never repeats a document name', () => {
  for (const diff of [{ attached: 'secret.pdf', source: 'upload' }, { linked: 'secret.pdf' },
    { removedDocument: 'secret.pdf' }]) {
    expect(auditSummary(auditEntry({ diff: JSON.stringify(diff) }))).not.toContain('secret.pdf');
  }
});

test('auditItem records who acted and puts the action in the past tense', () => {
  const html = auditItem(auditEntry({ actor: 'ai', action: 'create' }));
  expect(html).toContain('data-actor="ai"');
  expect(html).toContain('2026-07-31 09:12');
  expect(html).toContain('created');
});

test('auditItem treats labelHtml as markup so the feed can link records', () => {
  expect(auditItem(auditEntry(), '<a href="/customers/cus_1">Doe, Jane</a>'))
    .toContain('<a href="/customers/cus_1">Doe, Jane</a>');
});

test('auditList reports an empty history honestly', () => {
  expect(auditList([])).toContain('No activity recorded yet.');
  expect(auditList([auditEntry()], 'audit:customer:cus_1')).toContain('data-surface="audit:customer:cus_1"');
});

test('view mode shows a select option label, not the stored id', () => {
  const html = renderForm(customerSchema([client], 'customer.update'), 'view', { clientId: 'cli_1' });
  expect(html).toContain('Acme');
  expect(html).not.toContain('cli_1');
});

// ---- documents -------------------------------------------------------------

test('fileSize reports bytes exactly and larger units for reading', () => {
  expect(fileSize(0)).toBe('—');
  expect(fileSize(512)).toBe('512 B');
  expect(fileSize(2048)).toBe('2.0 KB');
  expect(fileSize(5 * 1024 * 1024)).toBe('5.0 MB');
});

test('previewKind decides what the browser can render inline', () => {
  expect(previewKind('image/png')).toBe('image');
  expect(previewKind('application/pdf')).toBe('pdf');
  expect(previewKind('text/plain')).toBe('text');
  expect(previewKind('application/vnd.ms-excel')).toBe('none');
});

test('documentChip carries its surface, source and escapes the name', () => {
  const d: DocumentRef = {
    id: 'doc_1', entity: 'ticket', entityId: 'tkt_1', name: '<script>.pdf',
    mimeType: 'application/pdf', size: 10, source: 'generated', storage: 'local',
    storageId: 'x', webViewLink: '', createdAt: '', createdBy: 'human',
  };
  const html = documentChip(d);
  expect(html).toContain('data-surface="document:doc_1"');
  expect(html).toContain('data-source="generated"');
  expect(html).not.toContain('<script>');
});

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: 'tic_1', customerId: 'cus_1', ticketId: 'TXDOEX0001', title: 'Annual Review',
  dateInitiated: '', status: 'In Progress', dateLastUpdated: '', waitingOn: '', waitingSince: '',
  summary: '', nextAction: '', progressLog: [], commRefs: [], createdAt: '', updatedAt: '',
  ...over,
});

test('every board column ships an empty state, so a filtered column can use it too', () => {
  const html = renderBoard([ticket()], () => 'Doe, Jane');
  // One per column, always — CSS hides it when the column shows a visible card,
  // which is what makes it work for a column the FILTER emptied.
  expect([...html.matchAll(/class="kanban-empty"/g)]).toHaveLength(TICKET_STATUSES.length);
  expect(html).toContain(`Nothing in ${TICKET_STATUSES[0]}`);
  // It lives inside the list, so it is not mistaken for a card: the count and
  // the filter both address `.kanban-card`.
  expect(html).not.toContain('class="kanban-empty" draggable');
});
