import { test, expect } from 'bun:test';
import { renderForm, customerSchema, esc, customerRow } from './html.ts';
import type { Client, Customer } from '../domain/types.ts';

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
