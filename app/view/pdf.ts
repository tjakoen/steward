// Branded ticket document renderer (0004). Produces a SELF-CONTAINED HTML doc
// — its own <style>, no app chrome — to be fed to headless Chrome for print.
// Pure function, no I/O: unit-testable without a browser. Branding arrives as
// data (Client.branding) and is emitted as CSS custom properties, never
// hardcoded. Client with a null logo degrades to a text wordmark.

import type { Client, Customer, Ticket } from '../domain/types.ts';
import { esc, personsLabel } from '../view/html.ts';

const NEUTRAL_PRIMARY = '#1f2933';
const NEUTRAL_SECONDARY = '#6b7280';

/** Only render a field block when it carries content. */
function block(label: string, value: string): string {
  return value.trim()
    ? `<section class="field"><h3>${esc(label)}</h3><p>${esc(value)}</p></section>`
    : '';
}

function header(client: Client): string {
  const b = client.branding;
  const mark = b.logoDataUrl
    ? `<img class="logo" src="${esc(b.logoDataUrl)}" alt="${esc(client.name)}" />`
    : `<span class="wordmark">${esc(client.name)}</span>`;
  return (
    `<header class="doc-head">${mark}` +
    (b.companyInfo.trim() ? `<div class="company">${esc(b.companyInfo)}</div>` : '') +
    `</header>`
  );
}

function progress(ticket: Ticket): string {
  if (!ticket.progressLog.length) return '';
  // Newest first — the print doc is a snapshot, most-recent update leads.
  const rows = [...ticket.progressLog]
    .reverse()
    .map((e) => `<li><time>${esc(e.date)}</time><span>${esc(e.update)}</span></li>`)
    .join('');
  return `<section class="field"><h3>Progress log</h3><ul class="log">${rows}</ul></section>`;
}

function comms(ticket: Ticket): string {
  if (!ticket.commRefs.length) return '';
  const rows = ticket.commRefs
    .map((c) => `<tr><td>${esc(c.date)}</td><td>${esc(c.subject)}</td></tr>`)
    .join('');
  return (
    `<section class="field"><h3>Communications</h3>` +
    `<table class="comms"><thead><tr><th>Date</th><th>Subject</th></tr></thead>` +
    `<tbody>${rows}</tbody></table></section>`
  );
}

/**
 * Render one ticket as a complete branded HTML document.
 * `customer`/`client` may be null (orphaned record) — the doc still renders,
 * degrading the affected fields rather than throwing.
 */
export function renderTicketDocument(
  ticket: Ticket,
  customer: Customer | null,
  client: Client | null,
): string {
  const b = client?.branding;
  const primary = b?.primaryColor?.trim() || NEUTRAL_PRIMARY;
  const secondary = b?.secondaryColor?.trim() || NEUTRAL_SECONDARY;
  const footer = b?.pdfFooter?.trim() ?? '';
  const who = customer ? personsLabel(customer) : '—';

  const waiting =
    ticket.status === 'Waiting' && ticket.waitingOn.trim()
      ? block('Waiting on', `${ticket.waitingOn}${ticket.waitingSince ? ` (since ${ticket.waitingSince})` : ''}`)
      : '';

  const clientHead = client ? header(client) : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${esc(ticket.ticketId)} — ${esc(ticket.title)}</title>
<style>
:root { --brand-primary: ${esc(primary)}; --brand-secondary: ${esc(secondary)}; }
@page { size: A4; margin: 18mm 16mm 22mm; }
* { box-sizing: border-box; }
body { font: 12px/1.5 -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #1a1a1a; margin: 0; }
.doc-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem;
  border-bottom: 3px solid var(--brand-primary); padding-bottom: 10px; margin-bottom: 18px; }
.logo { max-height: 56px; max-width: 220px; }
.wordmark { font-size: 20px; font-weight: 700; color: var(--brand-primary); letter-spacing: 0.02em; }
.company { font-size: 10px; color: var(--brand-secondary); white-space: pre-line; text-align: right; }
.title { margin: 0 0 2px; font-size: 20px; color: var(--brand-primary); }
.meta { margin: 0 0 20px; color: var(--brand-secondary); font-size: 11px; }
.meta .code { font-weight: 700; color: #1a1a1a; }
.field { margin: 0 0 14px; }
.field h3 { margin: 0 0 3px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--brand-primary); border-bottom: 1px solid var(--brand-secondary); padding-bottom: 2px; }
.field p { margin: 0; white-space: pre-line; }
.log { list-style: none; margin: 0; padding: 0; }
.log li { display: flex; gap: 10px; padding: 4px 0; border-bottom: 1px solid #eee; }
.log time { flex: 0 0 88px; color: var(--brand-secondary); font-variant-numeric: tabular-nums; }
.comms { width: 100%; border-collapse: collapse; }
.comms th, .comms td { text-align: left; padding: 4px 6px; border-bottom: 1px solid #eee; font-size: 11px; }
.comms th { color: var(--brand-secondary); text-transform: uppercase; font-size: 10px; letter-spacing: 0.05em; }
.doc-foot { position: fixed; bottom: -14mm; left: 0; right: 0; text-align: center;
  font-size: 9px; color: var(--brand-secondary); }
</style>
</head>
<body>
${clientHead}
<h1 class="title">${esc(ticket.title)}</h1>
<p class="meta"><span class="code">${esc(ticket.ticketId)}</span> · ${esc(who)} · ${esc(ticket.status)}
 · initiated ${esc(ticket.dateInitiated)} · updated ${esc(ticket.dateLastUpdated)}</p>
${block('Summary', ticket.summary)}
${block('Next action', ticket.nextAction)}
${waiting}
${progress(ticket)}
${comms(ticket)}
${footer ? `<footer class="doc-foot">${esc(footer)}</footer>` : ''}
</body>
</html>`;
}
