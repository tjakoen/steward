// The SHAPE of the Sheets mirror: records in, rows of strings out.
//
// Pure on purpose — no fetch, no auth, no Sheets vocabulary. The mapping is where
// the bugs live (a column that shifts, a list flattened into an unreadable cell),
// and a pure function is the only kind that can be tested without a network.
//
// Row 1 of every tab is a banner saying what this file is. Row 2 is the header.
// That is not decoration: the mirror is overwritten wholesale on every push, so a
// person editing it is about to lose their work, and the file has to say so where
// they are actually looking.

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

export const SPREADSHEET_TITLE = 'STEWARD mirror (read-only)';

const HEADERS: Record<TabTitle, string[]> = {
  // `archived` replaced `active` in 0012: the date, or blank. Archived rows STAY in the
  // sheet — a row that vanished would be indistinguishable from one a view filtered out,
  // and to a reader a disappearing row is data loss. It is a derived column and a pull
  // must never treat it as a field: archiving is a verb with an audit row, not a cell.
  Clients: ['id', 'code', 'name', 'archived', 'created', 'updated'],
  Customers: [
    'id', 'client code', 'customer code', 'persons', 'email', 'phone',
    'external id', 'notes', 'archived', 'created', 'updated',
  ],
  Tickets: [
    'id', 'ticket id', 'customer', 'client code', 'title', 'status', 'initiated',
    'last updated', 'waiting on', 'waiting since', 'next action', 'summary',
  ],
  Progress: ['ticket id', 'date', 'update'],
};

/** The header row is what everything below it lines up against. */
export const headersFor = (tab: TabTitle): string[] => [...HEADERS[tab]];

export function bannerFor(pushedAt: string): string {
  return `Read-only mirror of STEWARD. Rewritten on every push — edits made here are lost. ` +
    `Last pushed: ${pushedAt}`;
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
export function mirrorTabs(data: MirrorData, pushedAt: string): MirrorTab[] {
  const banner = bannerFor(pushedAt);
  // Codes, not ids, are what a person reading the sheet can cross-reference.
  const clientCode = new Map(data.clients.map((c) => [c.id, c.code]));
  const customerById = new Map(data.customers.map((c) => [c.id, c]));

  const tab = (title: TabTitle, rows: string[][]): MirrorTab => ({
    title,
    // The banner sits alone in column A; the header row defines the width.
    rows: [[banner], headersFor(title), ...rows],
  });

  return [
    tab('Clients', data.clients.map((c) => [
      c.id, c.code, c.name, c.archivedAt ?? '', c.createdAt, c.updatedAt,
    ])),

    tab('Customers', data.customers.map((c) => [
      c.id, clientCode.get(c.clientId) ?? '', c.code, personsLabel(c),
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
