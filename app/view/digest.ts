// The daily digest report (0013): pending work for one client, as a branded
// document sharing the ticket document's furniture.
//
// Pure — grouping AND rendering, no repository and no clock. `today` is always a
// parameter, which is what makes "7 days waiting" testable.
//
// Specified by nimbalyst-local/mockups/steward-digest.mockup.html, approved
// 2026-08-04. Grouping and the empty-case rule come from plans/0013-daily-digest.md.

import type { Client, Customer, DocumentRef, Ticket, TicketStatus } from '../domain/types.ts';
import { esc, personsLabel } from './html.ts';
import {
  daysBetween, documentCss, documentHead, documentTitle,
  formatDate, formatDayMonth, formatLongDate, formatWeekdayDate, plural,
} from './doc.ts';

/** A pending ticket with everything the report says about it, already gathered. */
export interface PendingTicket {
  ticket: Ticket;
  customer: Customer | null;
  documents: DocumentRef[];
}

/**
 * Pending = anything that is not `Completed`. Three of the four statuses.
 *
 * The order is not the enum's and is not an accident: what is stuck on somebody
 * else leads, because that is the list the reader can act on this morning.
 */
export const PENDING_STATUSES: TicketStatus[] = ['Waiting', 'In Progress', 'Not Commenced'];

export const isPending = (t: Ticket): boolean => t.status !== 'Completed';

export interface DigestGroup {
  status: TicketStatus;
  items: PendingTicket[];
}

/** One client's pending work, grouped and ordered. `total` is what the email counts. */
export interface ClientDigest {
  client: Client;
  groups: DigestGroup[]; // always three, in PENDING_STATUSES order; may be empty
  total: number;
  /** Age in days of the longest-waiting ticket, or null when nothing is waiting. */
  oldestWaitingDays: number | null;
  oldestWaiting: PendingTicket | null;
}

/** When a Waiting ticket started waiting. Falls back to when it was raised. */
const waitingFrom = (p: PendingTicket): string =>
  p.ticket.waitingSince?.trim() || p.ticket.dateInitiated;

const ageOf = (p: PendingTicket, today: string): number | null =>
  daysBetween(waitingFrom(p), today);

/** A day count that reads as urgent. Matches the mockup's gold treatment. */
const OLD_DAYS = 7;

/**
 * Group one client's pending tickets. Waiting is sorted oldest first — it is the
 * closest thing STEWARD has to an ageing report, and a list that is not in age
 * order is not one.
 */
export function digestFor(client: Client, pending: PendingTicket[], today: string): ClientDigest {
  const groups: DigestGroup[] = PENDING_STATUSES.map((status) => ({
    status,
    items: pending.filter((p) => p.ticket.status === status),
  }));
  const waiting = groups[0].items
    .slice()
    .sort((a, b) => waitingFrom(a).localeCompare(waitingFrom(b)));
  groups[0].items = waiting;

  const oldestWaiting = waiting[0] ?? null;
  return {
    client,
    groups,
    total: pending.length,
    oldestWaiting,
    oldestWaitingDays: oldestWaiting ? ageOf(oldestWaiting, today) : null,
  };
}

// ---- the report -------------------------------------------------------------

const DIGEST_CSS = `
.tally { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin: 22px 0 28px; break-inside: avoid; }
.tally .stat { border: 1px solid var(--rule); border-top: 3px solid var(--brand-primary); padding: 12px 14px; }
.tally .stat.is-waiting { border-top-color: var(--brand-secondary); }
.tally .n { display: block; font-size: 26px; line-height: 1.1; font-weight: 650;
  font-variant-numeric: tabular-nums; color: var(--brand-primary); }
.tally .k { font-size: 9px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-muted); }
.tally .sub { display: block; margin-top: 3px; font-size: 9.5px; color: var(--ink-faint); }
.group > h2 { display: flex; align-items: baseline; gap: 8px; }
.group > h2 .count { margin-left: auto; color: var(--ink-faint); letter-spacing: 0; font-weight: 600; }
.group .why { margin: 5px 0 10px; font-size: 9.5px; color: var(--ink-faint); }
.group td { padding: 8px 8px 8px 0; }
.col-code { width: 92px; }
.col-who { width: 150px; }
.col-age { width: 82px; text-align: right; white-space: nowrap; }
.age { font-variant-numeric: tabular-nums; color: var(--ink-muted); }
.age.is-old { color: var(--brand-secondary); font-weight: 650; }
.work-title { font-weight: 600; }
.next { display: block; margin-top: 2px; color: var(--ink-muted); }
.next::before { content: "Next: "; color: var(--ink-faint); }
.waiting-on { display: block; margin-top: 2px; font-size: 10px; color: var(--ink-muted); }
.waiting-on b { font-weight: 650; color: var(--ink); }
.links { margin: 5px 0 0; padding: 0; list-style: none; display: flex; flex-wrap: wrap; gap: 4px 14px; }
.links a { font-size: 10px; color: var(--brand-primary); text-decoration: none;
  border-bottom: 1px solid var(--brand-secondary); }
.links a::before { content: "\\2197"; margin-right: 4px; color: var(--brand-secondary); }
.empty { padding: 10px 0; color: var(--ink-faint); font-size: 10.5px; }
`.trim();

/**
 * The Drive files filed against a pending ticket — the part that makes this
 * report useful rather than decorative.
 *
 * A ticket with no documents renders no list. That absence is information too.
 * A document with no `webViewLink` (stored locally) is skipped rather than
 * printed as dead text: this list is links or nothing.
 */
function links(docs: DocumentRef[]): string {
  const items = docs.filter((d) => d.webViewLink);
  if (!items.length) return '';
  return `<ul class="links">${items
    .map((d) => `<li><a href="${esc(d.webViewLink)}">${esc(d.name)}</a></li>`)
    .join('')}</ul>`;
}

function workCell(p: PendingTicket, showWaitingOn: boolean): string {
  const t = p.ticket;
  const on = showWaitingOn && t.waitingOn.trim()
    ? `<span class="waiting-on">On <b>${esc(t.waitingOn)}</b>` +
      (t.waitingSince ? ` since ${esc(formatDate(t.waitingSince))}` : '') + `</span>`
    : '';
  const next = t.nextAction.trim() ? `<span class="next">${esc(t.nextAction)}</span>` : '';
  return `<span class="work-title">${esc(t.title)}</span>${on}${next}${links(p.documents)}`;
}

/** The right-hand column means something different in each group, so it is named per group. */
const AGE_HEADING: Record<string, string> = {
  Waiting: 'Waiting', 'In Progress': 'Updated', 'Not Commenced': 'Raised',
};

function ageCell(p: PendingTicket, status: TicketStatus, today: string): string {
  if (status === 'Waiting') {
    const d = ageOf(p, today);
    if (d === null) return '<span class="age">—</span>';
    return `<span class="age${d >= OLD_DAYS ? ' is-old' : ''}">${d} ${plural(d, 'day')}</span>`;
  }
  const when = status === 'In Progress' ? p.ticket.dateLastUpdated : p.ticket.dateInitiated;
  return `<span class="age">${esc(formatDayMonth(when))}</span>`;
}

function groupSection(g: DigestGroup, today: string): string {
  if (!g.items.length) return '';
  const waiting = g.status === 'Waiting';
  const rows = g.items.map((p) =>
    `<tr><td class="col-code"><span class="code">${esc(p.ticket.ticketId)}</span></td>` +
    `<td class="col-who">${esc(p.customer ? personsLabel(p.customer) : '—')}</td>` +
    `<td>${workCell(p, waiting)}</td>` +
    `<td class="col-age">${ageCell(p, g.status, today)}</td></tr>`,
  ).join('');
  return (
    `<section class="group">` +
    `<h2>${esc(g.status)} <span class="count">${g.items.length}</span></h2>` +
    (waiting ? `<p class="why">Sorted oldest first. These are not moving without someone else.</p>` : '') +
    `<table><thead><tr><th class="col-code">Ticket</th><th class="col-who">Customer</th><th>Work</th>` +
    `<th class="col-age">${esc(AGE_HEADING[g.status] ?? '')}</th></tr></thead>` +
    `<tbody>${rows}</tbody></table></section>`
  );
}

/** The line under each count. Empty when there is nothing true to say. */
function statSub(g: DigestGroup, d: ClientDigest, today: string): string {
  if (!g.items.length) return '';
  if (g.status === 'Waiting') {
    return d.oldestWaitingDays === null ? '' : `oldest ${d.oldestWaitingDays} ${plural(d.oldestWaitingDays, 'day')}`;
  }
  if (g.status === 'In Progress') {
    const week = g.items.filter((p) => {
      const days = daysBetween(p.ticket.dateLastUpdated, today);
      return days !== null && days <= 7;
    }).length;
    return week ? `${week} updated this week` : 'none updated this week';
  }
  const ages = g.items
    .map((p) => daysBetween(p.ticket.dateInitiated, today))
    .filter((n): n is number => n !== null);
  if (!ages.length) return '';
  const oldest = Math.max(...ages);
  return oldest === 0 ? 'raised today' : `oldest raised ${oldest} ${plural(oldest, 'day')} ago`;
}

function tally(d: ClientDigest, today: string): string {
  const stats = d.groups.map((g) =>
    `<div class="stat${g.status === 'Waiting' ? ' is-waiting' : ''}">` +
    `<span class="n">${g.items.length}</span><span class="k">${esc(g.status)}</span>` +
    (statSub(g, d, today) ? `<span class="sub">${esc(statSub(g, d, today))}</span>` : '') +
    `</div>`,
  ).join('');
  return `<div class="tally">${stats}</div>`;
}

/**
 * One client's pending work as a complete branded HTML document.
 *
 * `totalTickets` is only used by the empty case, to say what "nothing pending"
 * is out of. The digest send skips empty clients entirely (no attachment, no
 * section) — this renders one anyway when something asks for it directly.
 */
export function renderDigestDocument(d: ClientDigest, today: string, totalTickets = 0): string {
  const body = d.total
    ? tally(d, today) + d.groups.map((g) => groupSection(g, today)).join('')
    : `<p class="empty">Nothing is pending.${totalTickets ? ` All ${totalTickets} ${plural(totalTickets, 'ticket')} are completed.` : ''}</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${esc(d.client.name)} — pending work ${esc(today)}</title>
<style>
${documentCss(d.client)}
${DIGEST_CSS}
</style>
</head>
<body>
${documentHead(d.client)}
${documentTitle('Daily digest', `Pending work — ${formatWeekdayDate(today)}`)}
${body}
</body>
</html>`;
}

/** What one client's attachment is called. Dated, so a mailbox sorts them. */
export const digestFileName = (d: ClientDigest, today: string): string =>
  `${d.client.name.replace(/[^\w .-]+/g, ' ').trim()} — pending ${today}.pdf`;

// ---- the email itself -------------------------------------------------------
// Plain text, deliberately: an HTML mail that has to survive a dozen clients is
// its own project, and the branded artefact is the attachment. This body is meant
// to be readable on a phone without opening anything.

export function digestSubject(digests: ClientDigest[], today: string): string {
  const n = digests.reduce((sum, d) => sum + d.total, 0);
  const what = n ? `${n} pending ${plural(n, 'ticket')}` : 'nothing pending';
  return `STEWARD — ${what}, ${formatLongDate(today)}`;
}

/** "2 waiting, 1 in progress" — only the groups that have anything in them. */
const breakdown = (d: ClientDigest): string =>
  d.groups
    .filter((g) => g.items.length)
    .map((g) => `${g.items.length} ${g.status.toLowerCase()}`)
    .join(', ');

/**
 * The body. `completedTotal` lets the empty case say what "nothing" is out of —
 * an empty digest still sends, because a silent morning is indistinguishable
 * from a scheduler that died in the night.
 */
export function digestBody(digests: ClientDigest[], today: string, completedTotal = 0): string {
  const withWork = digests.filter((d) => d.total);
  const n = withWork.reduce((sum, d) => sum + d.total, 0);
  if (!n) {
    return `Nothing is pending this morning.` +
      (completedTotal ? `\n\nAll ${completedTotal} ${plural(completedTotal, 'ticket')} are completed.` : '') +
      `\n\nNo reports are attached.`;
  }

  const width = Math.max(...withWork.map((d) => d.client.name.length));
  const lines = withWork.map((d) =>
    `  ${d.client.name.padEnd(width)}  ${String(d.total).padStart(2)}   (${breakdown(d)})`,
  );

  // The single most useful sentence in the mail: the one thing that has been
  // stuck longest, named, so the reader knows what to do before opening a PDF.
  const oldest = withWork
    .map((d) => d.oldestWaiting)
    .filter((p): p is PendingTicket => p !== null)
    .sort((a, b) => waitingFrom(a).localeCompare(waitingFrom(b)))[0] ?? null;
  const age = oldest ? daysBetween(waitingFrom(oldest), today) : null;
  const oldestLine = oldest
    ? `\n\nThe oldest is ${oldest.ticket.ticketId} — ${oldest.ticket.title}, waiting on ` +
      `${oldest.ticket.waitingOn || 'someone'} since ${formatDate(waitingFrom(oldest))}` +
      (age === null ? '' : ` (${age} ${plural(age, 'day')})`) + '.'
    : '';

  const many = withWork.length > 1;
  return (
    `${n} ${plural(n, 'ticket is', 'tickets are')} pending this morning.\n\n` +
    lines.join('\n') + oldestLine +
    `\n\nA branded report is attached for ${many ? 'each client' : 'the client'}.`
  );
}
