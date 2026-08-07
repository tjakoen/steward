// Reading the mirror back: what the sheet says, minus what the database already holds.
//
// Pure, and deliberately so. This module never fetches, never writes and never sees a
// token; it takes the values `sheets.ts` read and the records `mirrorData()` produced and
// answers one question — *what would change* — so that the answer can be looked at by a
// person before any of it lands. Everything that makes this plan dangerous is decided in
// here, which means all of it can be tested without a spreadsheet.
//
// The load-bearing rule of the whole file: A CELL THAT STILL HOLDS EXACTLY WHAT STEWARD
// WROTE IS NOT VALIDATED AT ALL. The push writes RAW, so every untouched cell round-trips
// as the identical string; comparing before validating is what stops a pull from refusing
// over a value the app itself stored and this module happens not to like the look of.

import { TICKET_STATUSES, type Client, type Customer, type Person, type Ticket, type TicketStatus }
  from '../domain/types.ts';
import {
  PULL_COLUMNS, PULL_TABS, headersFor,
  type MirrorData, type PullColumn, type PullTab,
} from './mirror.ts';

/** One tab, read twice. See `sheets.ts` for why neither render option is enough alone. */
export interface TabValues {
  /** `UNFORMATTED_VALUE` — tells us the cell's TYPE. A date is a serial number here. */
  raw: unknown[][];
  /** `FORMATTED_VALUE` — tells us what the operator MEANT, digits intact. */
  text: unknown[][];
}
export type SheetValues = Partial<Record<PullTab, TabValues>>;

export interface FieldChange {
  /** The column header, which is what the operator sees. */
  header: string;
  from: string;
  to: string;
}

export interface RecordChange {
  tab: PullTab;
  id: string;
  /** 1-based sheet row, so it can be read off the spreadsheet. */
  row: number;
  /** Name, title — whatever a person would call this record. */
  label: string;
  fields: FieldChange[];
  patch: Record<string, unknown>;
  /**
   * Changed in STEWARD too, since the last push. The sheet still wins — that is the
   * decision of 2026-08-03 — but a silent overwrite of somebody's other edit is the one
   * conflict this plan is obliged to SHOW rather than merely resolve.
   */
  conflict: boolean;
}

/** A cell that cannot be read, named where the operator can go and fix it. */
export interface PullProblem {
  /** A1 notation — `Tickets!F7`. */
  where: string;
  message: string;
}

export interface PullPlan {
  changes: RecordChange[];
  problems: PullProblem[];
  /** Rows carrying an id STEWARD does not know. Reported, never silently dropped. */
  unknown: { tab: PullTab; id: string; row: number }[];
  /** Rows with no id at all: somebody started typing. A pull creates nothing. */
  blank: { tab: PullTab; row: number }[];
  /** How many records exist in STEWARD, for the blast-radius fraction. */
  records: number;
  /** Set when the plan must not be applied AT ALL, whatever the operator clicks. */
  refusal: string | null;
  /**
   * Big enough to be the shifted paste. Applying needs a second, explicit acknowledgement
   * — a speed bump, not a security control, and the only thing between a mis-paste and a
   * mass overwrite.
   */
  needsAck: boolean;
}

// --- A1 notation ------------------------------------------------------------

/** 0 → A, 25 → Z, 26 → AA. */
export function columnLetter(index: number): string {
  let n = index, out = '';
  do { out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return out;
}
const at = (tab: string, col: number, row: number): string => `${tab}!${columnLetter(col)}${row}`;

// --- coercion: a cell is a string, a number, or a lie ------------------------

/** Sheets counts days from 1899-12-30. Off-by-one here is a date four months out. */
const SERIAL_EPOCH_MS = Date.UTC(1899, 11, 30);

/** A Sheets date serial as `YYYY-MM-DD`. Fractional serials carry a time; the date is the day. */
export function fromSerial(serial: number): string {
  return new Date(SERIAL_EPOCH_MS + Math.floor(serial) * 86_400_000).toISOString().slice(0, 10);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type Coerced = { ok: true; value: string } | { ok: false; message: string };

/**
 * One cell, read for one kind of column.
 *
 * `raw` decides dates, because only the unformatted read is unambiguous about them:
 * `4/8/2026` rendered in someone else's locale is either August or April and guessing
 * between them is how a `waiting since` lands four months out with nobody the wiser.
 * `text` decides everything else, because it is the only read whose digits survived —
 * `JSON.parse` has already destroyed a sixteen-digit external id before we see it.
 */
export function coerceCell(raw: unknown, text: unknown, column: PullColumn): Coerced {
  const shown = String(text ?? '').trim();

  if (column.kind === 'date') {
    const r = typeof raw === 'string' ? raw.trim() : raw;
    if (r === '' || r === null || r === undefined) return blankOr(column, '');
    if (typeof r === 'number') return { ok: true, value: fromSerial(r) };
    if (typeof r === 'string' && ISO_DATE.test(r)) return { ok: true, value: r };
    return {
      ok: false,
      message: `"${shown || String(raw)}" is not a date. Use YYYY-MM-DD, or format the cell as a date.`,
    };
  }

  if (!shown) return blankOr(column, '');

  if (column.kind === 'status') {
    // Trimmed but NOT case-folded and not fuzzy-matched. Accepting near-misses trains the
    // sheet to be sloppy about the one field that drives the board and tomorrow's digest.
    if (!(TICKET_STATUSES as readonly string[]).includes(shown)) {
      return { ok: false, message: `"${shown}" is not a status. Use one of: ${TICKET_STATUSES.join(', ')}.` };
    }
    return { ok: true, value: shown };
  }

  return { ok: true, value: shown };
}

/** Empty clears an optional field, because the operator deleting the text meant it. */
const blankOr = (column: PullColumn, value: string): Coerced =>
  column.required
    ? { ok: false, message: `${column.header} cannot be empty.` }
    : { ok: true, value };

// --- the plan ---------------------------------------------------------------

const PERSON_SLOTS = ['given', 'family', 'given2', 'family2'] as const;

/** The same rule `personsFrom` encodes: a second person exists only when both halves do. */
export function personsFromSlots(slots: Record<string, string>): Person[] {
  const persons: Person[] = [{ given: slots.given, family: slots.family }];
  if (slots.given2 && slots.family2) persons.push({ given: slots.given2, family: slots.family2 });
  return persons;
}
const slotsOf = (persons: Person[]): Record<string, string> => ({
  given: persons[0]?.given ?? '', family: persons[0]?.family ?? '',
  given2: persons[1]?.given ?? '', family2: persons[1]?.family ?? '',
});

const label = (tab: PullTab, rec: Client | Customer | Ticket): string => {
  if (tab === 'Clients') return (rec as Client).name;
  if (tab === 'Tickets') return (rec as Ticket).ticketId;
  return slotsOf((rec as Customer).persons).family || (rec as Customer).code;
};

/** What the record holds today, as the string the push would have written. */
function currentValue(tab: PullTab, rec: Client | Customer | Ticket, field: string): string {
  if (tab === 'Customers' && (PERSON_SLOTS as readonly string[]).includes(field)) {
    return slotsOf((rec as Customer).persons)[field];
  }
  return String((rec as unknown as Record<string, unknown>)[field] ?? '');
}

const pad = (row: unknown[] | undefined, width: number): unknown[] => {
  // `values.get` TRUNCATES trailing empty cells. Read naively, index 9 of a short row is
  // `undefined` and `undefined` reads as "unchanged" when it means "cleared" — one line
  // of code between "the operator cleared the notes" and "the notes are immortal".
  const out = (row ?? []).slice(0, width);
  while (out.length < width) out.push('');
  return out;
};

export interface PlanInput {
  data: MirrorData;
  values: SheetValues;
  /** `sheets.pushed_at` — a record touched in STEWARD since then is a flagged conflict. */
  pushedAt: string | null;
}

/**
 * The diff, computed without touching the database.
 *
 * Keyed on column A and IGNORING ROW ORDER ENTIRELY — the sheet is read into a map, not a
 * list — which is what makes sorting free, an inserted row harmless and a deleted row
 * survivable. It does not save you from the fourth thing people do to spreadsheets: a block
 * pasted one row down, where every id is real and sits beside somebody else's values.
 * Nothing in the data distinguishes that from a legitimate bulk edit. Only a human looking
 * at the list of proposed changes does, which is the entire reason this returns a plan
 * instead of applying one.
 */
export function planPull(input: PlanInput): PullPlan {
  const { data, values, pushedAt } = input;
  const plan: PullPlan = {
    changes: [], problems: [], unknown: [], blank: [],
    records: data.clients.length + data.customers.length + data.tickets.length,
    refusal: null, needsAck: false,
  };
  const refuse = (reason: string) => { if (!plan.refusal) plan.refusal = reason; };

  const byId: Record<PullTab, Map<string, Client | Customer | Ticket>> = {
    Clients: new Map(data.clients.map((c) => [c.id, c])),
    Customers: new Map(data.customers.map((c) => [c.id, c])),
    Tickets: new Map(data.tickets.map((t) => [t.id, t])),
  };

  let idsSeen = 0;

  for (const tab of PULL_TABS) {
    const tv = values[tab];
    if (!tv) { refuse(`The ${tab} tab is missing from the mirror. Push first, then pull.`); continue; }

    // The header row is READ, never assumed: an older mirror has different columns, and
    // keying on position would then write emails into the notes with total confidence.
    const header = pad(tv.text[1], Math.max(headersFor(tab).length, (tv.text[1] ?? []).length))
      .map((h) => String(h ?? '').trim());
    const columns = PULL_COLUMNS[tab];
    const indexOf = (name: string) => header.indexOf(name);
    const idCol = indexOf('id');
    const missing = [
      ...(idCol < 0 ? ['id'] : []),
      ...columns.filter((c) => indexOf(c.header) < 0).map((c) => c.header),
    ];
    if (missing.length) {
      refuse(`The ${tab} tab is missing the ${missing.join(', ')} column${missing.length === 1 ? '' : 's'}. ` +
        `Push first — the mirror's columns are out of date.`);
      continue;
    }

    const width = header.length;
    const seen = new Set<string>();

    for (let i = 2; i < Math.max(tv.raw.length, tv.text.length); i += 1) {
      const row = i + 1; // 1-based, as the spreadsheet numbers it
      const raw = pad(tv.raw[i], width);
      const text = pad(tv.text[i], width);
      const id = String(text[idCol] ?? '').trim();

      if (!id) {
        // A row with no id is a person starting to type, and a half-typed customer is not
        // a customer. Reported so the count is visible, never acted on.
        if (text.some((c) => String(c ?? '').trim())) plan.blank.push({ tab, row });
        continue;
      }
      if (seen.has(id)) {
        // A paste that duplicates a block produces these, and there is no defensible way
        // to choose between two rows claiming the same record.
        refuse(`${tab} has two rows for the same record id (${id}), at ${at(tab, idCol, row)}. ` +
          `Remove the duplicate and pull again.`);
        continue;
      }
      seen.add(id);
      idsSeen += 1;

      const rec = byId[tab].get(id);
      if (!rec) { plan.unknown.push({ tab, id, row }); continue; }

      const fields: FieldChange[] = [];
      const patch: Record<string, unknown> = {};
      const slots: Record<string, string> = {};
      let slotsTouched = false;
      let bad = false;

      for (const column of columns) {
        const col = indexOf(column.header);
        const current = currentValue(tab, rec, column.field);
        const asWritten = raw[col] === null || raw[col] === undefined ? '' : String(raw[col]);
        const isPerson = tab === 'Customers' && (PERSON_SLOTS as readonly string[]).includes(column.field);

        // Untouched: the push wrote this exact string and it came back unchanged. No
        // validation, because validating a value the app itself stored can only ever
        // refuse a pull nobody asked for.
        if (asWritten === current) {
          if (isPerson) slots[column.field] = current;
          continue;
        }

        const read = coerceCell(raw[col], text[col], column);
        if (!read.ok) { plan.problems.push({ where: at(tab, col, row), message: read.message }); bad = true; continue; }

        if (isPerson) { slots[column.field] = read.value; slotsTouched = true; continue; }
        if (read.value === current) continue;
        fields.push({ header: column.header, from: current, to: read.value });
        patch[column.field] = column.field === 'status' ? (read.value as TicketStatus) : read.value;
      }
      if (bad) continue;

      if (tab === 'Customers' && slotsTouched) {
        // Diff the RESULT, not the cells: clearing `family 2` alone drops the second person
        // entirely, and a preview that showed only the cleared cell would be lying about
        // what apply does.
        const persons = personsFromSlots(slots);
        const was = slotsOf((rec as Customer).persons);
        const now = slotsOf(persons);
        let moved = false;
        for (const slot of PERSON_SLOTS) {
          if (was[slot] === now[slot]) continue;
          moved = true;
          fields.push({
            header: columns.find((c) => c.field === slot)!.header,
            from: was[slot], to: now[slot],
          });
        }
        if (moved) patch.persons = persons;
      }

      if (!fields.length) continue;
      plan.changes.push({
        tab, id, row, label: label(tab, rec), fields, patch,
        conflict: Boolean(pushedAt && rec.updatedAt > pushedAt),
      });
    }
  }

  // Every id unknown is the signature of pulling from the WRONG spreadsheet, and it is the
  // one case where a partial answer is worse than none.
  if (idsSeen > 0 && plan.unknown.length === idsSeen) {
    refuse('None of the ids in this spreadsheet belong to STEWARD. That is what pulling from ' +
      'the wrong file looks like, so nothing was read.');
  }
  // All-or-nothing. Half a document applied is a state neither the sheet nor the database
  // describes, and the operator cannot tell which half landed. The fix is five seconds in
  // the sheet — the problem names the cell — and re-pulling is free.
  if (plan.problems.length) {
    refuse(`${plan.problems.length} cell${plan.problems.length === 1 ? '' : 's'} could not be read, ` +
      `so nothing will be written. Fix them in the sheet and pull again.`);
  }

  // More than twenty-five records, or more than a quarter of them — with a FLOOR of four,
  // which the plan did not have and needs. A quarter of a nine-record workspace is two, so
  // the bare fraction demands a confirmation for editing two cells, and a speed bump that
  // fires on ordinary work is one the operator learns to click through — which costs
  // exactly the case it exists for. Four still trips the shifted paste: that accident
  // shifts a whole block, not a couple of rows.
  plan.needsAck = plan.changes.length > 25
    || (plan.changes.length >= 4 && plan.changes.length > plan.records / 4);

  return plan;
}

// --- what the operator actually read -----------------------------------------

/**
 * A fingerprint of the plan a human looked at.
 *
 * This replaces comparing Drive's `modifiedTime`, which was the plan's design and is
 * MEASURABLY UNSOUND: Drive lags a Sheets content edit by up to a minute (observed
 * 2026-08-07 — a write at 02:28 did not reach `modifiedTime`/`version` until 02:30), and
 * that minute is precisely the window in which somebody previews, reads and clicks. A
 * timestamp-based guard is therefore blind exactly when it is needed.
 *
 * The fingerprint is exact and needs no clock at all. It covers the changes, the problems
 * and the skipped rows — everything the preview put on screen — so an apply proceeds only
 * when the diff is still the one that was read. It picks up a change on EITHER side: if
 * the database moved instead of the sheet, the plan moves with it.
 */
export function planFingerprint(plan: PullPlan): string {
  const shape = JSON.stringify([
    plan.changes.map((c) => [c.tab, c.id, c.row, c.fields.map((f) => [f.header, f.from, f.to])]),
    plan.problems.map((p) => [p.where, p.message]),
    plan.unknown.map((u) => [u.tab, u.id, u.row]),
    plan.blank.map((b) => [b.tab, b.row]),
    plan.refusal,
  ]);
  // FNV-1a, 32-bit. A checksum, not a security boundary: the thing it guards against is a
  // colleague still typing, not an adversary choosing a collision.
  let h = 0x811c9dc5;
  for (let i = 0; i < shape.length; i += 1) {
    h ^= shape.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16)}-${shape.length}`;
}

// --- applying ---------------------------------------------------------------

/**
 * What a pull needs to be able to do, and nothing else.
 *
 * Structural rather than `Services` so this module stays testable without a database, and
 * narrow so that the list of verbs a pull can reach is visible in one place: it creates
 * nothing, deletes nothing, archives nothing and never touches documents, branding,
 * settings or the audit table directly.
 */
export interface PullWriter {
  transaction<T>(fn: () => T): T;
  updateClient(id: string, patch: Record<string, unknown>, by: string, diff?: unknown): unknown;
  updateCustomer(id: string, patch: Record<string, unknown>, by: string, diff?: unknown): unknown;
  updateTicket(id: string, patch: Record<string, unknown>, by: string, diff?: unknown): unknown;
}

/**
 * One transaction, through the services, so every write lands with its audit row or
 * neither does — `audit.append` is a separate INSERT, and a rollback that spared it would
 * leave a history of changes that did not happen.
 *
 * `bun:sqlite` transactions are SYNCHRONOUS: nothing in here may await. Fetching, planning
 * and validating are all finished before this is called, which is the ordering that keeps
 * that true rather than merely hoped for.
 */
export function applyPull(writer: PullWriter, plan: PullPlan, by: string): number {
  if (plan.refusal) throw new Error(plan.refusal);
  return writer.transaction(() => {
    for (const change of plan.changes) {
      // A pull STAMPS `last updated` rather than reading it: it is the app's own record of
      // when the work moved, and the digest reads it tomorrow morning. It is kept OUT of
      // the audit diff — the row must say what the operator changed, and one edited cell
      // that audits as "2 details changed" is a lie with a timestamp on it.
      const patch = change.tab === 'Tickets'
        ? { ...change.patch, dateLastUpdated: new Date().toISOString() }
        : change.patch;
      if (change.tab === 'Clients') writer.updateClient(change.id, patch, by, change.patch);
      else if (change.tab === 'Customers') writer.updateCustomer(change.id, patch, by, change.patch);
      else writer.updateTicket(change.id, patch, by, change.patch);
    }
    return plan.changes.length;
  });
}
