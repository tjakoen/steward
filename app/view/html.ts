// Server-side HTML builders. No template engine — plain, escaped strings.
// FormBuilder lives here: one schema-driven renderer with create/edit/view modes.

import type {
  Client, Customer, Ticket, ProgressEntry,
} from '../domain/types.ts';
import { TICKET_STATUSES } from '../domain/types.ts';

export function esc(s: unknown): string {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

// ---- FormBuilder ----------------------------------------------------------

export type FieldType = 'text' | 'email' | 'tel' | 'color' | 'textarea' | 'select';
export type FormMode = 'create' | 'edit' | 'view';

export interface Field {
  name: string;
  label: string;
  type?: FieldType;
  options?: { value: string; label: string }[]; // for select
  placeholder?: string;
}

export interface FormSchema {
  action: string; // steward action fired on submit (create/edit modes)
  fields: Field[];
  idField?: string; // hidden id carried in edit mode
}

function fieldControl(f: Field, value: string): string {
  const id = `f_${f.name}`;
  if (f.type === 'textarea') {
    return `<textarea id="${id}" name="${esc(f.name)}" placeholder="${esc(f.placeholder ?? '')}">${esc(value)}</textarea>`;
  }
  if (f.type === 'select') {
    const opts = (f.options ?? [])
      .map((o) => `<option value="${esc(o.value)}"${o.value === value ? ' selected' : ''}>${esc(o.label)}</option>`)
      .join('');
    return `<select id="${id}" name="${esc(f.name)}">${opts}</select>`;
  }
  const type = f.type === 'color' ? 'color' : f.type ?? 'text';
  return `<input id="${id}" name="${esc(f.name)}" type="${type}" value="${esc(value)}" placeholder="${esc(f.placeholder ?? '')}" />`;
}

function fieldDisplay(f: Field, value: string): string {
  if (f.type === 'color') {
    return `<span class="swatch" style="background:${esc(value)}"></span><code>${esc(value)}</code>`;
  }
  return `<span data-field-value>${esc(value) || '<em>—</em>'}</span>`;
}

/**
 * Render a FormBuilder form. `mode`:
 *  - create: empty inputs, submit → schema.action
 *  - edit:   inputs seeded from `values`, submit → schema.action, carries id
 *  - view:   display fields; a toggle flips to edit for the same record
 */
export function renderForm(
  schema: FormSchema,
  mode: FormMode,
  values: Record<string, string> = {},
): string {
  const rows = schema.fields
    .map((f) => {
      const v = values[f.name] ?? '';
      const control = mode === 'view' ? fieldDisplay(f, v) : fieldControl(f, v);
      return `<div class="form-row" data-field="${esc(f.name)}"><label${mode === 'view' ? '' : ` for="f_${esc(f.name)}"`}>${esc(f.label)}</label>${control}</div>`;
    })
    .join('');

  const idInput =
    schema.idField && values[schema.idField]
      ? `<input type="hidden" name="${esc(schema.idField)}" value="${esc(values[schema.idField])}" />`
      : '';

  const submitLabel = mode === 'create' ? 'Create' : 'Save';
  const controls =
    mode === 'view'
      ? `<button type="button" data-form-edit>Edit</button>`
      : `<button type="submit">${submitLabel}</button>` +
        (mode === 'edit' ? `<button type="button" data-form-cancel>Cancel</button>` : '');

  return (
    `<form class="fb" data-action="${esc(schema.action)}" data-mode="${mode}">` +
    idInput +
    rows +
    `<div class="form-controls">${controls}</div>` +
    `</form>`
  );
}

// ---- schemas + row renderers ----------------------------------------------

export function customerSchema(clients: Client[], action = 'customer.create'): FormSchema {
  return {
    action,
    idField: 'id',
    fields: [
      { name: 'clientId', label: 'Client', type: 'select',
        options: clients.map((c) => ({ value: c.id, label: c.name })) },
      { name: 'given', label: 'Given name(s)', type: 'text', placeholder: 'Jane' },
      { name: 'family', label: 'Family name', type: 'text', placeholder: 'Doe' },
      { name: 'given2', label: 'Given name (joint)', type: 'text', placeholder: 'optional' },
      { name: 'family2', label: 'Family name (joint)', type: 'text', placeholder: 'optional' },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'phone', label: 'Phone', type: 'tel' },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
  };
}

export function clientSchema(action = 'client.create'): FormSchema {
  return {
    action,
    idField: 'id',
    fields: [
      { name: 'name', label: 'Name', type: 'text', placeholder: 'Acme Advisory' },
      { name: 'code', label: 'Code', type: 'text', placeholder: 'acme' },
      { name: 'primaryColor', label: 'Primary color', type: 'color' },
      { name: 'secondaryColor', label: 'Secondary color', type: 'color' },
      { name: 'companyInfo', label: 'Company info', type: 'textarea' },
      { name: 'pdfFooter', label: 'PDF footer', type: 'text' },
    ],
  };
}

export function personsLabel(c: Customer): string {
  return c.persons.map((p) => `${p.family}, ${p.given}`).join(' and ');
}

export function customerRow(c: Customer): string {
  return (
    `<tr class="row" data-surface="customer:${esc(c.id)}" data-href="/customers/${esc(c.id)}">` +
    `<td><a href="/customers/${esc(c.id)}">${esc(personsLabel(c))}</a></td>` +
    `<td class="mono">${esc(c.code)}</td>` +
    `<td class="sub">${esc(c.email)}</td>` +
    `</tr>`
  );
}

export function clientRow(c: Client): string {
  const info = c.branding.companyInfo ? esc(c.branding.companyInfo) : '<span class="sub">—</span>';
  return (
    `<tr class="row" data-surface="client:${esc(c.id)}">` +
    `<td><span class="swatch" style="background:${esc(c.branding.primaryColor)}"></span><span class="name">${esc(c.name)}</span></td>` +
    `<td class="mono">${esc(c.code)}</td>` +
    `<td class="sub">${info}</td>` +
    `</tr>`
  );
}

// ---- tickets ---------------------------------------------------------------

/** Schema for creating a ticket: customer picker + the free-text fields. */
export function ticketSchema(customers: Customer[], action = 'ticket.create'): FormSchema {
  return {
    action,
    idField: 'id',
    fields: [
      { name: 'customerId', label: 'Customer', type: 'select',
        options: customers.map((c) => ({ value: c.id, label: personsLabel(c) })) },
      { name: 'title', label: 'Title', type: 'text', placeholder: 'Annual Review' },
      { name: 'summary', label: 'Summary', type: 'textarea' },
      { name: 'nextAction', label: 'Next action', type: 'text' },
      { name: 'waitingOn', label: 'Waiting on', type: 'text', placeholder: 'optional' },
    ],
  };
}

/** Schema for editing a ticket: no customer move, adds the status select. */
export function ticketEditSchema(action = 'ticket.update'): FormSchema {
  return {
    action,
    idField: 'id',
    fields: [
      { name: 'title', label: 'Title', type: 'text' },
      { name: 'status', label: 'Status', type: 'select',
        options: TICKET_STATUSES.map((s) => ({ value: s, label: s })) },
      { name: 'summary', label: 'Summary', type: 'textarea' },
      { name: 'nextAction', label: 'Next action', type: 'text' },
      { name: 'waitingOn', label: 'Waiting on', type: 'text' },
    ],
  };
}

/** One draggable ticket card. Lives inside a status column. */
export function ticketCard(t: Ticket, customerLabel: string): string {
  const waiting = t.status === 'Waiting' && t.waitingOn
    ? `<span class="muted">waiting: ${esc(t.waitingOn)}</span>` : '';
  return (
    `<li class="card" data-surface="ticket:${esc(t.id)}" draggable="true"` +
    ` data-ticket-id="${esc(t.id)}" data-status="${esc(t.status)}">` +
    `<a href="/tickets/${esc(t.id)}"><strong>${esc(t.title)}</strong></a>` +
    `<span class="muted mono">${esc(t.ticketId)}</span>` +
    `<span class="muted">${esc(customerLabel)}</span>${waiting}` +
    `</li>`
  );
}

/** Kanban board: one column per status, each column a drop zone. */
export function renderBoard(tickets: Ticket[], labelOf: (t: Ticket) => string): string {
  const byStatus: Record<string, Ticket[]> = {};
  for (const t of tickets) (byStatus[t.status] ??= []).push(t);
  const cols = TICKET_STATUSES.map((s) => {
    const list = byStatus[s] ?? [];
    const cards = list.map((t) => ticketCard(t, labelOf(t))).join('');
    return (
      `<div class="board-col" data-status="${esc(s)}">` +
      `<h2>${esc(s)} <span class="count">${list.length}</span></h2>` +
      `<ul class="cards" data-surface="ticket-col:${esc(s)}">${cards}</ul>` +
      `</div>`
    );
  }).join('');
  return `<div class="board">${cols}</div>`;
}

/** One progress-log entry, as a list item (appended live via SSE). */
export function progressItem(e: ProgressEntry): string {
  return `<li><time>${esc(e.date)}</time> ${esc(e.update)}</li>`;
}

export function progressList(t: Ticket): string {
  const items = t.progressLog.map(progressItem).join('') || '<li class="muted">No entries yet.</li>';
  return `<ul class="progress" data-surface="ticket-progress:${esc(t.id)}">${items}</ul>`;
}
