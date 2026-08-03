// Branded ticket document renderer (0004, reshaped by 0013). Produces a
// SELF-CONTAINED HTML doc — its own <style>, no app chrome — to be fed to
// headless Chrome for print. Pure function, no I/O: unit-testable without a
// browser. Branding arrives as data (Client.branding) and is emitted as CSS
// custom properties, never hardcoded. A client with a null logo degrades to a
// text wordmark.
//
// The shared furniture (head, type, tables, footer, dates) lives in ./doc.ts,
// because the daily digest is the same document with a different body.
//
// The footer is NOT in this markup any more. It is Chrome's `footerTemplate`,
// handed to `printToPdf` via `documentPrintOptions` — see doc.ts for why, and
// for the blank second page that used to fall out of doing it the other way.

import type { Client, Customer, DocumentRef, Ticket } from '../domain/types.ts';
import { esc, personsLabel } from './html.ts';
import { daysBetween, documentCss, documentHead, documentTitle, formatDate, plural } from './doc.ts';

/** Only render a field block when it carries content. */
function block(label: string, value: string): string {
  return value.trim()
    ? `<section class="field"><h2>${esc(label)}</h2><p>${esc(value)}</p></section>`
    : '';
}

/** One labelled cell of the meta grid. */
const cell = (label: string, html: string): string =>
  `<div><dt>${esc(label)}</dt><dd>${html}</dd></div>`;

function meta(ticket: Ticket, who: string): string {
  const pill = `<span class="pill${ticket.status === 'Waiting' ? ' is-waiting' : ''}">${esc(ticket.status)}</span>`;
  return (
    `<dl class="meta">` +
    cell('Ticket', `<span class="code">${esc(ticket.ticketId)}</span>`) +
    cell('Customer', esc(who)) +
    cell('Status', pill) +
    cell('Initiated', esc(formatDate(ticket.dateInitiated))) +
    cell('Updated', esc(formatDate(ticket.dateLastUpdated))) +
    `</dl>`
  );
}

/**
 * "Waiting on X since Y" as a callout rather than one section among many.
 *
 * It is the single line a reader scans a stuck ticket for, and as a paragraph in
 * the list it read like any other. `today` is a parameter so the age is a pure
 * function of its inputs — the renderer never asks the clock what time it is.
 */
function waitingCallout(ticket: Ticket, today: string): string {
  if (ticket.status !== 'Waiting' || !ticket.waitingOn.trim()) return '';
  const days = ticket.waitingSince ? daysBetween(ticket.waitingSince, today) : null;
  const since = ticket.waitingSince
    ? `since ${esc(formatDate(ticket.waitingSince))}${days !== null && days >= 0 ? ` · ${days} ${plural(days, 'day')}` : ''}`
    : '';
  return (
    `<div class="callout"><span class="label">Waiting on</span>` +
    `<span class="who">${esc(ticket.waitingOn)}</span>` +
    (since ? `<span class="since">${since}</span>` : '') +
    `</div>`
  );
}

function progress(ticket: Ticket): string {
  if (!ticket.progressLog.length) return '';
  // Newest first — the print doc is a snapshot, most-recent update leads.
  const rows = [...ticket.progressLog]
    .reverse()
    .map((e) => `<tr><td class="col-date">${esc(formatDate(e.date))}</td><td>${esc(e.update)}</td></tr>`)
    .join('');
  return `<section class="field"><h2>Progress log</h2><table><tbody>${rows}</tbody></table></section>`;
}

function comms(ticket: Ticket): string {
  if (!ticket.commRefs.length) return '';
  const rows = ticket.commRefs
    .map((c) => `<tr><td class="col-date">${esc(formatDate(c.date))}</td><td>${esc(c.subject)}</td></tr>`)
    .join('');
  return (
    `<section class="field"><h2>Communications</h2>` +
    `<table><thead><tr><th class="col-date">Date</th><th>Subject</th></tr></thead>` +
    `<tbody>${rows}</tbody></table></section>`
  );
}

const SOURCE_LABEL: Record<string, string> = {
  generated: 'Generated', upload: 'Uploaded', link: 'Linked',
};

/**
 * The files filed against this ticket — new in 0013, and it is odd that the
 * artefact which gets sent on never carried them.
 *
 * A document with no `webViewLink` (anything stored locally) prints as plain
 * text. A dead link on paper is worse than a file name.
 */
export function documentsSection(docs: DocumentRef[]): string {
  if (!docs.length) return '';
  const rows = docs.map((d) => {
    const name = d.webViewLink
      ? `<a class="doclink" href="${esc(d.webViewLink)}">${esc(d.name)}</a>`
      : esc(d.name);
    return (
      `<tr><td>${name}</td>` +
      `<td class="col-narrow">${esc(SOURCE_LABEL[d.source] ?? d.source)}</td>` +
      `<td class="col-date">${esc(formatDate(d.createdAt))}</td></tr>`
    );
  }).join('');
  return (
    `<section class="field"><h2>Documents</h2>` +
    `<table><thead><tr><th>File</th><th class="col-narrow">Source</th><th class="col-date">Added</th></tr></thead>` +
    `<tbody>${rows}</tbody></table></section>`
  );
}

/** Layout only this document needs; the rest comes from `documentCss`. */
const TICKET_CSS = `
.meta { display: grid; grid-template-columns: repeat(5, 1fr); gap: 0; margin: 0 0 24px;
  border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); }
.meta div { padding: 9px 14px 9px 0; }
.meta dt { margin: 0 0 2px; font-size: 8.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-faint); }
.meta dd { margin: 0; font-size: 11.5px; }
.callout { display: flex; gap: 12px; align-items: baseline; padding: 10px 14px; margin: 0 0 20px;
  border-left: 3px solid var(--brand-secondary); background: #faf7f0; break-inside: avoid; }
.callout .label { font-size: 9px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-muted); }
.callout .who { font-weight: 650; }
.callout .since { margin-left: auto; font-size: 10.5px; color: var(--ink-muted); font-variant-numeric: tabular-nums; }
.col-narrow { width: 120px; }
`.trim();

/**
 * Render one ticket as a complete branded HTML document.
 *
 * `customer`/`client` may be null (orphaned record) — the doc still renders,
 * degrading the affected fields rather than throwing. `documents` defaults to
 * none, so a caller that has not fetched them gets the document without that
 * section rather than a crash. `today` is injected for the waiting age.
 */
export function renderTicketDocument(
  ticket: Ticket,
  customer: Customer | null,
  client: Client | null,
  documents: DocumentRef[] = [],
  today: string = new Date().toISOString().slice(0, 10),
): string {
  const who = customer ? personsLabel(customer) : '—';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${esc(ticket.ticketId)} — ${esc(ticket.title)}</title>
<style>
${documentCss(client)}
${TICKET_CSS}
</style>
</head>
<body>
${documentHead(client)}
${documentTitle('Task ticket', ticket.title)}
${meta(ticket, who)}
${waitingCallout(ticket, today)}
${block('Summary', ticket.summary)}
${block('Next action', ticket.nextAction)}
${progress(ticket)}
${comms(ticket)}
${documentsSection(documents)}
</body>
</html>`;
}
