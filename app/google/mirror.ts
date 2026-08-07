// The SHAPE of the Sheets mirror: records in, rows of strings out — and, since 0011,
// which of those columns come back in.
//
// Pure on purpose — no fetch, no auth, no Sheets vocabulary. The mapping is where
// the bugs live (a column that shifts, a list flattened into an unreadable cell),
// and a pure function is the only kind that can be tested without a network.
//
// Row 1 of every tab is a banner saying what this file is. Row 2 is the header.
// That is not decoration: a person editing this file needs to know, where they are
// actually looking, which of their typing survives and which of it does not.

import type { Client, Customer, Ticket } from '../domain/types.ts';

export interface MirrorData {
  clients: Client[];
  customers: Customer[];
  tickets: Ticket[];
}

export interface MirrorTab {
  title: string;
  /** Everything the tab holds: banner row, header row, then the data. */
  rows: string[][];
}

/** Tab titles, in the order they appear in the spreadsheet. */
export const TAB_TITLES = ['Clients', 'Customers', 'Tickets', 'Progress'] as const;
export type TabTitle = (typeof TAB_TITLES)[number];

// Not "(read-only)" any more, and the rename is the honest half of 0011: the file
// IS read back now, and a title that says otherwise is the first thing a person sees.
export const SPREADSHEET_TITLE = 'STEWARD mirror';

const HEADERS: Record<TabTitle, string[]> = {
  // `archived` replaced `active` in 0012: the date, or blank. Archived rows STAY in the
  // sheet — a row that vanished would be indistinguishable from one a view filtered out,
  // and to a reader a disappearing row is data loss. It is a derived column and a pull
  // must never treat it as a field: archiving is a verb with an audit row, not a cell.
  Clients: ['id', 'code', 'name', 'archived', 'created', 'updated'],
  // `persons` is the readable join and `given`/`family`/`given 2`/`family 2` are the
  // fields (0011). Both are here because the join is what a human reading the sheet
  // wants and the four parts are the only thing a pull can safely put back:
  // "Family, Given and Family, Given" is not invertible — a family name containing
  // " and ", a given name containing a comma, or a single-word entry all parse wrong,
  // and wrong here means a customer's NAME corrupted by a process that reported success.
  Customers: [
    'id', 'client code', 'customer code', 'persons',
    'given', 'family', 'given 2', 'family 2',
    'email', 'phone', 'external id', 'notes', 'archived', 'created', 'updated',
  ],
  Tickets: [
    'id', 'ticket id', 'customer', 'client code', 'title', 'status', 'initiated',
    'last updated', 'waiting on', 'waiting since', 'next action', 'summary',
  ],
  Progress: ['ticket id', 'date', 'update'],
};

/** The header row is what everything below it lines up against. */
export const headersFor = (tab: TabTitle): string[] => [...HEADERS[tab]];

// --- which columns a pull may write, and what kind of value each holds (0011) -------
//
// Getting this list wrong is how a pull corrupts data while doing exactly what it was
// told, so the omissions are as deliberate as the entries and each has its own reason:
//
//   - `id`, `created`, `updated` are structurally unpatchable already — `New*` omits
//     them (app/repo/ports.ts) and the compiler forbids it. Not restated here.
//   - `client code` (Customers, Tickets) and `customer` (Tickets) are DERIVED. Writing
//     a ticket's client code reads like a request to re-parent it, through a column
//     that is not even the parent's key.
//   - `archived` is 0012's verb, not a field. A date typed there archives nothing.
//   - `code` on Clients is what the other two tabs join on: reading a rename out of a
//     document that is internally inconsistent about it mid-read has no good answer.
//   - `customer code` feeds `makeTicketId` (app/ids.ts) and every existing ticket
//     carries the OLD code inside its human id forever. Renaming it here would leave
//     the Progress tab half-agreeing with the Tickets tab.
//   - `last updated` is the app's own record of when the work moved. A pull STAMPS it
//     rather than reading it, exactly as every other mutation does.
export type PullTab = Extract<TabTitle, 'Clients' | 'Customers' | 'Tickets'>;
export const PULL_TABS: readonly PullTab[] = ['Clients', 'Customers', 'Tickets'];

/** How a cell is read back. `status` is the closed set; `date` is `YYYY-MM-DD` or a serial. */
export type PullKind = 'text' | 'date' | 'status';

export interface PullColumn {
  /** The header text, which is how the column is FOUND — never its position. */
  header: string;
  /** The patch key, or one of the four person slots. */
  field: string;
  kind: PullKind;
  /** Clearing it is the shape of an accident, not an edit: the domain has no blank for it. */
  required?: boolean;
}

export const PULL_COLUMNS: Record<PullTab, PullColumn[]> = {
  Clients: [{ header: 'name', field: 'name', kind: 'text', required: true }],
  Customers: [
    { header: 'given', field: 'given', kind: 'text', required: true },
    { header: 'family', field: 'family', kind: 'text', required: true },
    { header: 'given 2', field: 'given2', kind: 'text' },
    { header: 'family 2', field: 'family2', kind: 'text' },
    { header: 'email', field: 'email', kind: 'text' },
    { header: 'phone', field: 'phone', kind: 'text' },
    { header: 'external id', field: 'externalId', kind: 'text' },
    { header: 'notes', field: 'notes', kind: 'text' },
  ],
  Tickets: [
    { header: 'title', field: 'title', kind: 'text', required: true },
    { header: 'status', field: 'status', kind: 'status', required: true },
    { header: 'initiated', field: 'dateInitiated', kind: 'date' },
    { header: 'waiting on', field: 'waitingOn', kind: 'text' },
    { header: 'waiting since', field: 'waitingSince', kind: 'date' },
    { header: 'next action', field: 'nextAction', kind: 'text' },
    { header: 'summary', field: 'summary', kind: 'text' },
  ],
};

/** Every column that is neither the id nor pullable — the grey ones, in header order. */
export function derivedHeaders(tab: TabTitle): string[] {
  if (!(PULL_TABS as readonly string[]).includes(tab)) return headersFor(tab).slice(1);
  const pullable = new Set(PULL_COLUMNS[tab as PullTab].map((c) => c.header));
  return headersFor(tab).slice(1).filter((h) => !pullable.has(h));
}

/**
 * The banner, which after 0011 has to distinguish the two kinds of column.
 *
 * It used to say "edits made here are lost", full stop. That sentence was true when the
 * mirror only ever wrote; the day a pull exists it is false for most of the file and
 * still true for the rest, and only naming both halves is honest.
 */
export function bannerFor(tab: TabTitle, pushedAt: string, pulledAt: string | null): string {
  const stamps = `Last pushed: ${pushedAt}. Last pulled: ${pulledAt ?? 'never'}.`;
  if (tab === 'Progress') {
    return `STEWARD mirror. This tab is never read back — log progress in STEWARD. ` +
      `Rewritten on every push. ${stamps}`;
  }
  return `STEWARD mirror. Column A is the record id — never change it. ` +
    `The white columns are read back when someone runs a pull; the grey ones are not. ` +
    `A push overwrites everything. ${stamps}`;
}

/** "Family, Given and Family, Given" — joint customers are one row, not two. */
const personsLabel = (c: Customer): string =>
  c.persons.map((p) => `${p.family}, ${p.given}`).join(' and ');

/**
 * Every tab, fully rendered.
 *
 * `branding.logoDataUrl` is deliberately absent: it is a base64 image, routinely
 * past Sheets' 50,000-character cell limit, and no reader of a status report wants
 * it. Documents are absent too — a tab of Drive links duplicates /files for an
 * audience that cannot click through to STEWARD anyway.
 */
export function mirrorTabs(data: MirrorData, pushedAt: string, pulledAt: string | null = null): MirrorTab[] {
  // Codes, not ids, are what a person reading the sheet can cross-reference.
  const clientCode = new Map(data.clients.map((c) => [c.id, c.code]));
  const customerById = new Map(data.customers.map((c) => [c.id, c]));

  const tab = (title: TabTitle, rows: string[][]): MirrorTab => ({
    title,
    // The banner sits alone in column A; the header row defines the width.
    rows: [[bannerFor(title, pushedAt, pulledAt)], headersFor(title), ...rows],
  });

  return [
    tab('Clients', data.clients.map((c) => [
      c.id, c.code, c.name, c.archivedAt ?? '', c.createdAt, c.updatedAt,
    ])),

    tab('Customers', data.customers.map((c) => [
      c.id, clientCode.get(c.clientId) ?? '', c.code, personsLabel(c),
      c.persons[0]?.given ?? '', c.persons[0]?.family ?? '',
      c.persons[1]?.given ?? '', c.persons[1]?.family ?? '',
      c.email, c.phone, c.externalId, c.notes, c.archivedAt ?? '', c.createdAt, c.updatedAt,
    ])),

    tab('Tickets', data.tickets.map((t) => {
      const customer = customerById.get(t.customerId);
      return [
        t.id, t.ticketId, customer ? personsLabel(customer) : '',
        customer ? clientCode.get(customer.clientId) ?? '' : '',
        t.title, t.status, t.dateInitiated, t.dateLastUpdated,
        t.waitingOn, t.waitingSince, t.nextAction, t.summary,
      ];
    })),

    // A progress log is a list per ticket. Truncated into one cell it is
    // unreadable; joined with newlines it is a cell nobody can filter. So it gets
    // its own tab, keyed by the HUMAN ticket id — which is also the shape someone
    // building a pivot table actually wants.
    tab('Progress', data.tickets.flatMap((t) =>
      t.progressLog.map((e) => [t.ticketId, e.date, e.update]),
    )),
  ];
}

/** Row counts for the reply — the data rows, not the banner and header. */
export function mirrorCounts(tabs: MirrorTab[]): Record<string, number> {
  return Object.fromEntries(tabs.map((t) => [t.title, Math.max(0, t.rows.length - 2)]));
}
