// The furniture every printed STEWARD document shares (0013).
//
// Two documents leave this office — a ticket and a daily digest — and they are
// meant to look like it: same head, same type scale, same section rule, same
// footer. That shared look lives here rather than being copied into two
// renderers that then drift.
//
// Everything is a pure string builder. Branding arrives as data (Client.branding)
// and is emitted as CSS custom properties; nothing here knows a hex code.
//
// Specified by nimbalyst-local/mockups/steward-ticket.mockup.html and
// …/steward-digest.mockup.html, approved 2026-08-04.

import type { Client } from '../domain/types.ts';
import type { PrintOptions } from '../pdf/print.ts';
import { esc } from './html.ts';

const NEUTRAL_PRIMARY = '#1f2933';
const NEUTRAL_SECONDARY = '#6b7280';

/** Only two of these are the client's. The rest are ink and paper. */
export const INK = { body: '#1a1a1a', muted: '#5b6169', faint: '#9aa0a6', rule: '#e6e6e3' };

/**
 * Page geometry, in millimetres, matching the mockups' guides.
 *
 * The bottom margin is the biggest for a reason: it has to HOLD the footer.
 * Chrome clips a footer template to the margin box, so a bottom margin too small
 * for it renders nothing at all, which reads exactly like the feature being broken.
 */
export const PAGE = { top: 18, right: 16, bottom: 22, left: 16 };

/**
 * A system stack rather than the mockup's Inter. The mockup is read in a browser
 * that can fetch a webfont; this document is printed by a headless Chrome on the
 * operator's own machine, where an absent Inter would silently fall back anyway.
 */
const FONT = `ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;

/**
 * The same idea for the footer, and it must contain NO DOUBLE QUOTES.
 *
 * The footer is a `style="…"` attribute, not a stylesheet, so a quoted family name
 * inside it closes the attribute and silently discards every declaration after the
 * opening quote — which is not a broken footer but a nearly invisible one, crushed
 * into the bottom-left corner. Found exactly that way on 2026-08-04. Helvetica and
 * Arial need no quotes and cover both platforms this ships to.
 */
const FOOTER_FONT = `Helvetica, Arial, sans-serif`;

const primaryOf = (c: Client | null): string => c?.branding.primaryColor?.trim() || NEUTRAL_PRIMARY;
const secondaryOf = (c: Client | null): string => c?.branding.secondaryColor?.trim() || NEUTRAL_SECONDARY;

/** The whole visual language, once. Both documents include exactly this. */
export function documentCss(client: Client | null): string {
  return `
:root { --brand-primary: ${esc(primaryOf(client))}; --brand-secondary: ${esc(secondaryOf(client))};
  --ink: ${INK.body}; --ink-muted: ${INK.muted}; --ink-faint: ${INK.faint};
  --rule: ${INK.rule}; --rule-soft: #f0f0ed; }
* { box-sizing: border-box; }
body { margin: 0; font: 11.5px/1.55 ${FONT}; color: var(--ink); }

.doc-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px;
  border-bottom: 3px solid var(--brand-primary); padding-bottom: 12px; }
.logo { max-height: 56px; max-width: 220px; width: auto; }
.wordmark { font-size: 19px; font-weight: 700; letter-spacing: .01em; color: var(--brand-primary); }
.company { font-size: 9.5px; line-height: 1.5; color: var(--ink-muted); text-align: right; white-space: pre-line; }

.doc-kicker { margin: 26px 0 0; font-size: 10px; letter-spacing: .09em; text-transform: uppercase;
  color: var(--brand-secondary); font-weight: 600; }
.doc-title { margin: 0 0 14px; font-size: 21px; line-height: 1.25; font-weight: 650; color: var(--brand-primary); }

.field, .group { margin: 0 0 20px; break-inside: avoid; }
.field h2, .group > h2 { margin: 0 0 6px; font-size: 9.5px; letter-spacing: .1em; text-transform: uppercase;
  color: var(--brand-primary); font-weight: 700;
  border-bottom: 1px solid var(--brand-secondary); padding-bottom: 3px; }
.field p { margin: 0; white-space: pre-line; }

table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: 8.5px; letter-spacing: .08em; text-transform: uppercase; font-weight: 600;
  color: var(--ink-faint); padding: 0 8px 4px 0; border-bottom: 1px solid var(--rule); }
td { padding: 6px 8px 6px 0; border-bottom: 1px solid var(--rule-soft); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
.col-date { width: 82px; color: var(--ink-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }

.code { font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: .02em; }
.pill { display: inline-block; padding: 1.5px 9px; border-radius: 999px; font-size: 10px; font-weight: 600;
  border: 1px solid var(--brand-primary); color: var(--brand-primary); }
.pill.is-waiting { background: var(--brand-secondary); border-color: var(--brand-secondary); color: #fff; }

/* Printed, so the LABEL carries the meaning — the URL is never shown. */
.doclink { color: var(--brand-primary); text-decoration: none; border-bottom: 1px solid var(--brand-secondary); }
.doclink::before { content: "\\2197"; margin-right: 5px; color: var(--brand-secondary); font-size: 10px; }
`.trim();
}

/**
 * The head: the client's mark on the left, their company block on the right.
 * A client with no logo gets a wordmark, which is a real design and not a
 * placeholder — some clients will prefer it.
 */
export function documentHead(client: Client | null): string {
  if (!client) return '';
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

/** Kicker over title — "Task ticket", "Daily digest". Says what the reader is holding. */
export function documentTitle(kicker: string, title: string): string {
  return `<p class="doc-kicker">${esc(kicker)}</p><h1 class="doc-title">${esc(title)}</h1>`;
}

/**
 * The footer, as Chrome's own `footerTemplate` rather than an element in the flow.
 *
 * This is the fix for the defect the 2026-08-03 verify pass found: a `position: fixed`
 * footer below the page content box is OVERFLOW, and overflow is a second page — every
 * short ticket PDF used to ship a near-blank page 2. It is also the only way a page
 * number is possible at all.
 *
 * Written as one flat string of inline styles on purpose. The template is rendered in a
 * SEPARATE document with no access to the page's stylesheet, so a class here would do
 * nothing, and Chrome's default font size in this box is unreadably small unless set.
 */
export function footerTemplate(client: Client | null): string {
  const text = client?.branding.pdfFooter?.trim() ?? '';
  const secondary = secondaryOf(client);
  const box =
    `width:100%; font-family:${FOOTER_FONT}; font-size:8.5px; color:${INK.faint};` +
    // The template spans the FULL page width, not the content box, so it has to
    // re-create the side margins itself or the footer hangs off the text block.
    `padding:6px ${PAGE.left}mm 0; display:flex; align-items:center; gap:16px;` +
    `border-top:1px solid ${INK.rule};`;
  return (
    `<div style="${box}">` +
    `<span style="color:${esc(secondary)}">${esc(text)}</span>` +
    `<span style="margin-left:auto; font-variant-numeric:tabular-nums">` +
    `Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>` +
    `</div>`
  );
}

/**
 * What to hand `printToPdf` for a branded document: A4, the mockup's margins, and
 * the footer in the bottom one. The header template is deliberately blank — the
 * branded head belongs in the flow, where it can carry a logo and wrap.
 */
export function documentPrintOptions(client: Client | null): PrintOptions {
  return { margins: PAGE, footerTemplate: footerTemplate(client) };
}

// ---- dates -----------------------------------------------------------------
// Stored dates are ISO, and not consistently the same ISO: `today()` writes
// "2026-08-04" while `setTicketStatus` writes a full timestamp. Both arrive here.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-07-27" or "2026-07-27T09:12:44.000Z" → "27 Jul 2026". Anything else passes through. */
export function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  if (!m) return iso ?? '';
  const [, y, mo, d] = m;
  return `${Number(d)} ${MONTHS[Number(mo) - 1] ?? mo} ${y}`;
}

/** Shorter form for a column that is read as a scale, not a date — "1 Aug". */
export function formatDayMonth(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  if (!m) return iso ?? '';
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]}`;
}

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "2026-08-03" → "3 August 2026". For a subject line, where the month is read as a word. */
export function formatLongDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  if (!m) return iso ?? '';
  return `${Number(m[3])} ${MONTHS_LONG[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/**
 * "2026-08-03" → "Monday 3 August 2026".
 *
 * Parsed as UTC deliberately: a bare date string parsed as local time lands on the
 * previous day west of Greenwich, and a digest titled with yesterday's weekday is
 * the kind of bug nobody reports and everybody notices.
 */
export function formatWeekdayDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  if (!m) return iso ?? '';
  const at = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `${WEEKDAYS[new Date(at).getUTCDay()]} ${formatLongDate(iso)}`;
}

/** Whole days from an ISO date to another, or null when either is unparseable. */
export function daysBetween(fromIso: string, toIso: string): number | null {
  const a = Date.parse((fromIso ?? '').slice(0, 10));
  const b = Date.parse((toIso ?? '').slice(0, 10));
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

export const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);
