import { test, expect } from 'bun:test';
import {
  renderForm, customerSchema, esc, customerRow,
  auditTime, auditSummary, auditItem, auditList,
} from './html.ts';
import type { AuditEntry, Client, Customer } from '../domain/types.ts';

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

// ---- audit trail -----------------------------------------------------------

test('auditTime renders an ISO stamp as date + minutes', () => {
  expect(auditTime('2026-07-31T09:12:44.000Z')).toBe('2026-07-31 09:12');
  expect(auditTime('nonsense')).toBe('nonsense');
});

test('auditSummary names changed fields but never their values', () => {
  const e = auditEntry({ diff: JSON.stringify({ id: 'cus_1', email: 'secret@example.com', notes: 'private' }) });
  const summary = auditSummary(e);
  expect(summary).toBe('email, notes');
  expect(summary).not.toContain('secret@example.com');
  expect(summary).not.toContain('private');
});

test('auditSummary special-cases status moves and progress entries', () => {
  expect(auditSummary(auditEntry({ diff: JSON.stringify({ status: 'Completed' }) }))).toBe('status → Completed');
  expect(auditSummary(auditEntry({ diff: JSON.stringify({ addProgress: { date: '', update: 'x' } }) }))).toBe('progress logged');
  expect(auditSummary(auditEntry({ diff: 'not json' }))).toBe('');
});

test('auditItem records who acted and escapes the action', () => {
  const html = auditItem(auditEntry({ actor: 'ai', action: 'create' }));
  expect(html).toContain('data-actor="ai"');
  expect(html).toContain('2026-07-31 09:12');
  expect(html).toContain('create');
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
