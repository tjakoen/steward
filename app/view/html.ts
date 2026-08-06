// Server-side HTML builders. No template engine — plain, escaped strings.
// FormBuilder lives here: one schema-driven renderer with create/edit/view modes.

import type {
  AuditEntry, Client, Customer, DocumentRef, Ticket, ProgressEntry,
} from '../domain/types.ts';
import { TICKET_STATUSES } from '../domain/types.ts';

export function esc(s: unknown): string {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

// ---- icons -----------------------------------------------------------------
// GRAIN ships a sprite of 24×24 line glyphs at /assets/sprite.svg and a sized
// `.icon` box to hang them in. Referencing the sprite (rather than inlining the
// paths) keeps one copy of every glyph and lets it be cached like any asset.

/** Glyph names carried by GRAIN's sprite — a typo here renders nothing at all. */
export type IconName =
  | 'loop' | 'tasks' | 'knowledge' | 'rules' | 'traces' | 'settings' | 'menu'
  | 'close' | 'chevron-left' | 'chevron-right' | 'send' | 'search' | 'spark'
  | 'check' | 'plus' | 'files' | 'pin';

/**
 * One sprite glyph. Decorative by default: every place STEWARD uses an icon
 * also carries a visible label or an `aria-label`, and announcing the same
 * thing twice is noise. `.icon` is GRAIN's box and sizes BOTH dimensions —
 * a STEWARD class rides alongside it for placement, never instead of it.
 */
export function icon(name: IconName, className?: string, size?: 'sm' | 'lg'): string {
  return (
    `<svg class="icon${className ? ` ${esc(className)}` : ''}"` +
    `${size ? ` data-size="${size}"` : ''} aria-hidden="true" focusable="false">` +
    `<use href="/assets/sprite.svg#${name}"></use></svg>`
  );
}

// ---- Panel tabs (0014) -----------------------------------------------------
// A DISCLOSURE tabset, wearing GRAIN's `.tab` and `.tab-bar`.
//
// GRAIN's tab means an editor's open file — a navigation link, active by `aria-current`,
// closable, driven by `grain/scripts/tabs.js` out of localStorage. STEWARD does not load
// that script (it would rewrite the strip on first paint and delete these tabs) and does
// not claim that meaning: no `aria-current`, because this is not navigation. What it takes
// is the BOX, through `data-active="true"` — the semantics-free half of GRAIN's own active
// rule — and supplies the meaning itself in ARIA. The two never argue.
//
// Not one line of new tab CSS: `.tab` and `.tab-bar` are already in /components.css on
// every page, and `app/view/css.test.ts` would fail on a STEWARD rule that named either.
// `.panel-tabs` / `.panel-pane` are STEWARD's own, worn alongside.

export interface PanelTab {
  /** URL-safe, and the value of `?tab=`. */
  id: string;
  label: string;
  body: string;
}

/**
 * Which tab a request asked for, or the first one.
 *
 * An unknown `?tab=` must not select nothing: every pane hidden is a blank drawer, and a
 * blank drawer reads as a broken app rather than as a bad link.
 */
export function resolveTab(tabs: PanelTab[], requested?: string | null): string {
  const wanted = (requested ?? '').trim().toLowerCase();
  return tabs.some((t) => t.id === wanted) ? wanted : (tabs[0]?.id ?? '');
}

/**
 * The tablist and its panes, as one block.
 *
 * `base` must be unique PER RECORD: a drawer and a full page can hold panels for different
 * records in one session, and the drawer's body is replaced wholesale, so ids derived from
 * the tab name alone would collide and `aria-controls` would point at the wrong pane.
 *
 * Exactly one tab is `tabindex="0"` — a tablist is ONE stop in the Tab order, and the arrow
 * keys move within it (steward-tabs.js). Panes are hidden with the `hidden` ATTRIBUTE, not
 * with opacity: GRAIN's drawer recomputes its focus trap from `offsetParent !== null` on
 * every Tab keypress, so `hidden` drops a pane out of the trap for free.
 */
export function panelTabs(base: string, tabs: PanelTab[], active?: string | null): string {
  if (tabs.length < 2) return tabs.map((t) => t.body).join('');
  const current = resolveTab(tabs, active);
  const tabId = (id: string) => `${esc(base)}-tab-${esc(id)}`;
  const paneId = (id: string) => `${esc(base)}-pane-${esc(id)}`;

  const strip = tabs.map((t) => {
    const on = t.id === current;
    return (
      `<button type="button" class="tab" role="tab" id="${tabId(t.id)}"` +
      ` aria-controls="${paneId(t.id)}" aria-selected="${on}"` +
      (on ? ' data-active="true"' : '') +
      ` tabindex="${on ? 0 : -1}" data-tab="${esc(t.id)}">${esc(t.label)}</button>`
    );
  }).join('');

  const panes = tabs.map((t) => {
    const on = t.id === current;
    // `tabindex="0"` on the pane: it is the Tab stop after the tablist, and a pane whose
    // content is a list rather than a control would otherwise be unreachable by keyboard.
    return (
      `<section class="panel-pane" role="tabpanel" id="${paneId(t.id)}"` +
      ` aria-labelledby="${tabId(t.id)}" tabindex="0"${on ? '' : ' hidden'}>${t.body}</section>`
    );
  }).join('');

  return (
    `<nav class="tab-bar panel-tabs" role="tablist" aria-label="Record sections"` +
    ` data-panel-tabs="${esc(base)}">${strip}</nav>${panes}`
  );
}

// ---- Facets (0014) ---------------------------------------------------------
// A filter that is a URL is a filter you can send, bookmark, reload into, and hand to the
// AI — GRAIN's dispatcher already has a `navigate` op, so `/tickets?status=Waiting` is
// reachable by the reasoner the moment it exists, with no new action and no new surface.
//
// The control is GRAIN's `chip-group`, whose own .md opens by calling itself a facet
// control: native inputs inside labels, zero JS, form-postable, keyboard and AX for free.
// The bar is a plain `<form method="get">` with a real submit button, so it works with
// JavaScript switched off entirely — which is the whole reason the decision went to the
// server rather than to a DOM state nobody can name.

export interface FacetOption {
  value: string;
  label: string;
  /** How many records this value would match. Omitted where it cannot be computed. */
  count?: number;
}

/**
 * One group of chips.
 *
 * The `<fieldset class="chips">` is GRAIN's; the name of the group is a sibling `<span>`
 * rather than a `<legend>`, because a legend inside a `display: flex` fieldset is laid out
 * by the UA outside the flex flow and lands in the middle of the pills. `aria-label` says
 * the same thing to a screen reader with none of that risk.
 */
export function facetChips(
  name: string, legend: string, options: FacetOption[], selected: string[], multi = true,
): string {
  if (!options.length) return '';
  const type = multi ? 'checkbox' : 'radio';
  const chips = options.map((o) => {
    const on = selected.includes(o.value);
    return (
      `<label class="chips__chip"><input type="${type}" name="${esc(name)}" value="${esc(o.value)}"` +
      `${on ? ' checked' : ''}><span>${esc(o.label)}` +
      (o.count === undefined ? '' : ` <span class="facets__count">${o.count}</span>`) +
      `</span></label>`
    );
  }).join('');
  return (
    `<div class="facets__group"><span class="facets__label">${esc(legend)}</span>` +
    `<fieldset class="chips" data-select="${multi ? 'multi' : 'single'}" aria-label="${esc(legend)}">` +
    `${chips}</fieldset></div>`
  );
}

/**
 * One dropdown facet — for a set that grows with the workspace.
 *
 * Chips are right for a closed enum (four statuses, three sources). A client list is
 * neither closed nor short, and forty pills is not a filter bar, it is the list again.
 */
export function facetSelect(
  name: string, legend: string, options: FacetOption[], selected: string, allLabel: string,
): string {
  if (!options.length) return '';
  const opts = [{ value: '', label: allLabel }, ...options]
    .map((o) => `<option value="${esc(o.value)}"${o.value === selected ? ' selected' : ''}>${esc(o.label)}</option>`)
    .join('');
  const id = `facet_${esc(name)}`;
  return (
    `<div class="facets__group"><label class="facets__label" for="${id}">${esc(legend)}</label>` +
    `<select id="${id}" name="${esc(name)}" class="facets__select">${opts}</select></div>`
  );
}

/** A date bound. Two of these make the range the audit trail wants. */
export function facetDate(name: string, legend: string, value: string): string {
  const id = `facet_${esc(name)}`;
  return (
    `<div class="facets__group"><label class="facets__label" for="${id}">${esc(legend)}</label>` +
    `<input id="${id}" type="date" name="${esc(name)}" value="${esc(value)}" class="facets__date"></div>`
  );
}

/**
 * The bar itself.
 *
 * `id` matters: the topbar's text box lives in another region of the shell entirely and
 * joins this form through the `form` attribute, which is how Enter in the box becomes a
 * server round trip while typing in it still narrows what is on screen instantly.
 */
export function facetBar(
  id: string, action: string, groups: string, active: boolean,
): string {
  if (!groups) return '';
  return (
    `<form class="facets" id="${esc(id)}" method="get" action="${esc(action)}">` +
    groups +
    `<div class="facets__actions">` +
    `<button type="submit" class="btn" data-variant="soft">Apply</button>` +
    (active ? `<a class="linkish facets__clear" href="${esc(action)}">Clear filters</a>` : '') +
    `</div></form>`
  );
}

/**
 * The row a table shows when the CLIENT-side box has hidden everything.
 *
 * It ships on every non-empty list and CSS hides it whenever a visible row exists — the
 * same trick the kanban's empty column uses (`:has`), so there is nothing to keep in step
 * and no JS-maintained empty state to get wrong. It names the way out, because Escape and
 * Clear both already exist and go unmentioned exactly when they are needed.
 */
export function tableFilteredEmpty(colspan: number): string {
  return (
    `<tr class="dtable-none"><td colspan="${colspan}">Nothing here matches what you typed. ` +
    `Press Escape, or use Clear, to bring the rest back.</td></tr>`
  );
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
  // A select stores an id but means its label — show what the human picked,
  // not the key it maps to.
  if (f.type === 'select') {
    const opt = (f.options ?? []).find((o) => o.value === value);
    return `<span data-field-value>${esc(opt ? opt.label : value) || '<em>—</em>'}</span>`;
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
      ? `<button type="button" class="btn" data-form-edit>Edit</button>`
      : `<button type="submit" class="btn" data-variant="soft">${submitLabel}</button>` +
        (mode === 'edit' ? `<button type="button" class="btn" data-form-cancel>Cancel</button>` : '');

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
  const info = c.branding.companyInfo ? esc(c.branding.companyInfo) : '<span class="data-table__sub">—</span>';
  return (
    `<tr class="row" data-surface="client:${esc(c.id)}" data-href="/clients/${esc(c.id)}">` +
    `<td><span class="swatch" style="background:${esc(c.branding.primaryColor)}"></span>` +
    `<a href="/clients/${esc(c.id)}">${esc(c.name)}</a></td>` +
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
    `<li class="kanban-card" data-surface="ticket:${esc(t.id)}" draggable="true"` +
    ` data-ticket-id="${esc(t.id)}" data-status="${esc(t.status)}" data-href="/tickets/${esc(t.id)}">` +
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
    // The empty state ships on every column, always: CSS hides it whenever a
    // visible card exists, so a column the FILTER emptied says the same thing an
    // actually-empty one does, with nothing to keep in step.
    return (
      `<div class="kanban-col" data-status="${esc(s)}">` +
      `<h2>${esc(s)} <span class="count">${list.length}</span></h2>` +
      `<ul class="kanban-cards" data-surface="ticket-col:${esc(s)}">${cards}` +
      `<li class="kanban-empty">Nothing in ${esc(s)}</li></ul>` +
      `</div>`
    );
  }).join('');
  return `<div class="kanban">${cols}</div>`;
}

/** One progress-log entry, as a list item (appended live via SSE). */
export function progressItem(e: ProgressEntry): string {
  return `<li><time>${esc(e.date)}</time> ${esc(e.update)}</li>`;
}

export function progressList(t: Ticket): string {
  const items = t.progressLog.map(progressItem).join('') || '<li class="muted">No entries yet.</li>';
  return `<ul class="progress" data-surface="ticket-progress:${esc(t.id)}">${items}</ul>`;
}

// ---- documents -------------------------------------------------------------

/** Human file size. Bytes are exact; anything larger is rounded for reading. */
export function fileSize(bytes: number): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** Which files the browser can show inline, vs which it can only hand over. */
export function previewKind(mimeType: string): 'image' | 'pdf' | 'text' | 'none' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('text/') || mimeType === 'application/json') return 'text';
  return 'none';
}

/** A document as a chip, for the Documents section of a record panel. */
export function documentChip(d: DocumentRef): string {
  return (
    `<a class="chip" href="/files/${esc(d.id)}" data-href="/files/${esc(d.id)}" ` +
    `data-surface="document:${esc(d.id)}">` +
    `<span class="chip__badge" data-source="${esc(d.source)}">${esc(d.source)}</span>` +
    `${esc(d.name)}</a>`
  );
}

export function documentChips(docs: DocumentRef[], surface: string): string {
  const items = docs.map(documentChip).join('')
    || '<p class="muted">No documents yet.</p>';
  return `<div class="chips" data-surface="${esc(surface)}">${items}</div>`;
}

// ---- audit trail -----------------------------------------------------------
// The audit table has recorded every mutation since 0001; these render it.

/** "2026-07-31T09:12:44.000Z" → "2026-07-31 09:12". Display-only. */
export function auditTime(iso: string): string {
  return iso.length >= 16 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso;
}

const AUDIT_VERBS: Record<string, string> = {
  create: 'created', update: 'updated', archive: 'archived', restore: 'restored',
  delete: 'deleted',
};

/** The stored action verb as English. Unknown verbs pass through unchanged. */
export function auditVerb(action: string): string {
  return AUDIT_VERBS[action] ?? action;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * Say what an audit row's `diff` (a JSON blob of the change) MEANS, in the
 * words the operator uses.
 *
 * Two things are withheld. **Values**, because a diff carries notes, contact
 * details and file names, and the timeline is a scannable "what happened", not
 * a data dump — the record itself shows current values. **Field names**, too:
 * "persons, email, phone, notes" is the shape of the storage, not the shape of
 * the work, and an operator should never have to read a column name to know
 * what someone did.
 *
 * The one value that stays is the ticket status: it is a fixed workflow state
 * from a published list, carries no personal data, and is the single thing a
 * reader of the timeline is most often looking for.
 */
export function auditSummary(e: AuditEntry): string {
  let parsed: unknown;
  try { parsed = JSON.parse(e.diff); } catch { return ''; }
  if (!parsed || typeof parsed !== 'object') return '';
  const d = parsed as Record<string, unknown>;
  const keys = Object.keys(d).filter((k) => k !== 'id');
  if (!keys.length) return '';

  // Document changes audit against the OWNING record, so they arrive here as a
  // one-key diff whose key is the verb.
  if ('addProgress' in d) return 'progress logged';
  if ('attached' in d) return d.source === 'generated' ? 'document generated' : 'file uploaded';
  if ('linked' in d) return 'Drive file linked';
  if ('removedDocument' in d) return 'document removed';
  // The digest leaves the building, so it audits against every client whose work
  // was in it. The recipient is in the diff; the message body never is.
  if ('digestSentTo' in d) return 'daily digest emailed';
  if ('logo' in d) return d.logo === null ? 'logo removed' : 'logo set';

  // A create writes every field; "created Ticket TCK-4" already said it.
  if (e.action === 'create') return '';

  if (typeof d.status === 'string') {
    const rest = keys.length - 1;
    return rest
      ? `status set to ${d.status}, and ${rest} other ${plural(rest, 'detail', 'details')} changed`
      : `status set to ${d.status}`;
  }
  return `${keys.length} ${plural(keys.length, 'detail', 'details')} changed`;
}

/**
 * One audit row: when, who, what. `actor` is stamped at the door (human | ai).
 * `labelHtml` names the record the row belongs to (used by the workspace-wide
 * feed, where rows from different records are interleaved) — it is RAW HTML so
 * callers can link it, and callers are responsible for escaping its text.
 */
export function auditItem(e: AuditEntry, labelHtml?: string): string {
  const summary = auditSummary(e);
  return (
    `<li class="audit__row">` +
    `<time>${esc(auditTime(e.at))}</time>` +
    `<span class="badge audit__actor" data-actor="${esc(e.actor)}">${esc(e.actor)}</span>` +
    `<span class="audit__what">${esc(auditVerb(e.action))}${labelHtml ? ` ${labelHtml}` : ''}` +
    (summary ? ` <span class="sub">· ${esc(summary)}</span>` : '') +
    `</span></li>`
  );
}

/** Activity timeline for one record (newest first — repo returns it sorted). */
export function auditList(entries: AuditEntry[], surface?: string): string {
  const items = entries.map((e) => auditItem(e)).join('')
    || '<li class="muted">No activity recorded yet.</li>';
  const s = surface ? ` data-surface="${esc(surface)}"` : '';
  return `<ul class="audit"${s}>${items}</ul>`;
}
