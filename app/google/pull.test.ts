import { test, expect } from 'bun:test';
import { PULL_TABS, headersFor, mirrorTabs, type MirrorData, type PullTab } from './mirror.ts';
import {
  applyPull, columnLetter, fromSerial, planFingerprint, planPull,
  type PullPlan, type PullWriter, type SheetValues,
} from './pull.ts';
import type { Client, Customer, Ticket } from '../domain/types.ts';

const AT = '2026-08-01T10:00:00.000Z';

const client = (over: Partial<Client> = {}): Client => ({
  id: 'cl_1', name: 'Acme', code: 'ACME', archivedAt: null,
  branding: { logoDataUrl: null, primaryColor: '', secondaryColor: '', companyInfo: '', pdfFooter: '' },
  createdAt: AT, updatedAt: AT, ...over,
});
const customer = (over: Partial<Customer> = {}): Customer => ({
  id: 'cu_1', clientId: 'cl_1', code: 'DOEX', persons: [{ given: 'Jane', family: 'Doe' }],
  email: 'jane@example.com', phone: '555', externalId: '4111111111111111', notes: 'note',
  archivedAt: null, createdAt: AT, updatedAt: AT, ...over,
});
const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: 't_1', customerId: 'cu_1', ticketId: 'TXDOEX0001', title: 'Do the thing',
  dateInitiated: '2026-07-01', status: 'In Progress', dateLastUpdated: '2026-07-20',
  waitingOn: 'the bank', waitingSince: '2026-07-10', summary: 'summary', nextAction: 'chase',
  progressLog: [], commRefs: [], createdAt: AT, updatedAt: AT, ...over,
});

const data = (over: Partial<MirrorData> = {}): MirrorData => ({
  clients: [client()], customers: [customer()], tickets: [ticket()], ...over,
});

/**
 * The sheet as it stands the instant after a push.
 *
 * Built from `mirrorTabs` rather than hand-written, so the identity test below is a real
 * round trip: the push writes RAW, which is why every cell comes back as the same STRING
 * in both render options.
 */
function sheetOf(d: MirrorData): SheetValues {
  const tabs = mirrorTabs(d, AT);
  const out: SheetValues = {};
  for (const tab of PULL_TABS) {
    const rows = tabs.find((t) => t.title === tab)!.rows.map((r) => [...r] as unknown[]);
    out[tab] = { raw: rows, text: rows.map((r) => [...r]) };
  }
  return out;
}

/** Type into a cell. `raw` is what the unformatted read returns; `text` the formatted one. */
function type_(v: SheetValues, tab: PullTab, row: number, header: string, raw: unknown, text = raw): void {
  const col = headersFor(tab).indexOf(header);
  v[tab]!.raw[row][col] = raw;
  v[tab]!.text[row][col] = typeof text === 'number' ? String(text) : text;
}

const plan = (d: MirrorData, v: SheetValues, pushedAt: string | null = AT): PullPlan =>
  planPull({ data: d, values: v, pushedAt });

// --- the identity test, first, because it is the one nobody writes ----------
//
// If a clean round trip proposes even one edit, every other result here is noise: that is
// the format-coercion bug, the truncated-row bug and the derived-column bug all announcing
// themselves at once.

test('push, change nothing, preview: zero changes', () => {
  const p = plan(data(), sheetOf(data()));
  expect(p.changes).toEqual([]);
  expect(p.problems).toEqual([]);
  expect(p.unknown).toEqual([]);
  expect(p.blank).toEqual([]);
  expect(p.refusal).toBeNull();
});

test('a sixteen-digit external id survives the round trip', () => {
  // JSON.parse has already destroyed the precision of an unformatted read before we see
  // it, which is why every text field is taken from the FORMATTED one.
  const v = sheetOf(data());
  type_(v, 'Customers', 2, 'external id', 4_111_111_111_111_111, '4111111111111111');
  expect(plan(data(), v).changes).toEqual([]);
});

// --- one edit, and what the audit row is owed -------------------------------

test('one edited cell is one change, naming the field', () => {
  const v = sheetOf(data());
  type_(v, 'Tickets', 2, 'next action', 'call them back');

  const p = plan(data(), v);
  expect(p.changes).toHaveLength(1);
  expect(p.changes[0].tab).toBe('Tickets');
  expect(p.changes[0].id).toBe('t_1');
  expect(p.changes[0].label).toBe('TXDOEX0001');
  expect(p.changes[0].fields).toEqual([{ header: 'next action', from: 'chase', to: 'call them back' }]);
  // The patch is ONLY what changed — a pull that patched nine unchanged fields alongside
  // one changed one would audit as "9 details changed", which is a lie with a timestamp.
  expect(p.changes[0].patch).toEqual({ nextAction: 'call them back' });
});

test('whitespace is trimmed, and a cell of only spaces is empty', () => {
  const v = sheetOf(data());
  type_(v, 'Tickets', 2, 'next action', '  chase  ');
  expect(plan(data(), v).changes).toEqual([]);

  type_(v, 'Tickets', 2, 'next action', '   ');
  expect(plan(data(), v).changes[0].fields[0].to).toBe('');
});

// --- what row order means, which is nothing --------------------------------

test('sorting the tab changes nothing, because the sheet is read into a map', () => {
  const d = data({ tickets: [ticket(), ticket({ id: 't_2', ticketId: 'TXDOEX0002', title: 'Another' })] });
  const v = sheetOf(d);
  const rows = v.Tickets!;
  [rows.raw[2], rows.raw[3]] = [rows.raw[3], rows.raw[2]];
  [rows.text[2], rows.text[3]] = [rows.text[3], rows.text[2]];

  expect(plan(d, v).changes).toEqual([]);
});

test('a blank row inserted in the middle is reported and acted on not at all', () => {
  const v = sheetOf(data());
  v.Tickets!.raw.splice(2, 0, ['', '', '', '', 'half a thought']);
  v.Tickets!.text.splice(2, 0, ['', '', '', '', 'half a thought']);

  const p = plan(data(), v);
  // A pull creates nothing: an inserted row is a person starting to type, and a half-typed
  // customer is not a customer.
  expect(p.changes).toEqual([]);
  expect(p.blank).toEqual([{ tab: 'Tickets', row: 3 }]);
  expect(p.refusal).toBeNull();
});

test('a row deleted from the sheet deletes nothing', () => {
  const v = sheetOf(data());
  v.Tickets!.raw.splice(2, 1);
  v.Tickets!.text.splice(2, 1);
  // Absence is indistinguishable from a filtered view or a hidden row, and
  // deletion-by-absence would destroy records nobody touched.
  expect(plan(data(), v).changes).toEqual([]);
});

// --- the trailing-truncation trap ------------------------------------------

test('trailing empty cells mean CLEARED, not unchanged', () => {
  // `values.get` truncates them, so the last row of a tab comes back short. Read naively,
  // index 9 is `undefined` and `undefined` reads as "unchanged" when it means "cleared".
  const v = sheetOf(data());
  v.Tickets!.raw[2] = v.Tickets!.raw[2].slice(0, 6);
  v.Tickets!.text[2] = v.Tickets!.text[2].slice(0, 6);

  const p = plan(data(), v);
  const cleared = p.changes[0].fields.map((f) => f.header);
  expect(cleared).toContain('waiting on');
  expect(cleared).toContain('next action');
  expect(cleared).toContain('summary');
  expect(p.changes[0].patch.summary).toBe('');
});

// --- a cell is a string, a number, or a lie ---------------------------------

test('a status must be one of the four, exactly', () => {
  const v = sheetOf(data());
  type_(v, 'Tickets', 2, 'status', 'In Progres');

  const p = plan(data(), v);
  expect(p.problems).toHaveLength(1);
  expect(p.problems[0].where).toBe('Tickets!F3');
  expect(p.problems[0].message).toContain('Not Commenced');
  // All-or-nothing: half a document applied is a state neither side describes.
  expect(p.refusal).toContain('nothing will be written');
  expect(p.changes).toEqual([]);
});

test('a near-miss status is rejected rather than helpfully corrected', () => {
  const v = sheetOf(data());
  type_(v, 'Tickets', 2, 'status', 'in progress');
  // Accepting it would train the sheet to be sloppy about the one field driving the board
  // columns and tomorrow's digest.
  expect(plan(data(), v).problems).toHaveLength(1);
});

test('one bad cell stops the good edits in the same pull', () => {
  const v = sheetOf(data());
  type_(v, 'Tickets', 2, 'status', 'Nope');
  type_(v, 'Clients', 2, 'name', 'Acme Holdings');

  const p = plan(data(), v);
  expect(p.refusal).not.toBeNull();
  // The operator's mental model is "I edited the sheet, then I pulled". Applying the good
  // half would make that model wrong in a way nothing on screen corrects.
  expect(() => applyPull(writerSpy().writer, p, 'sheet:x')).toThrow();
});

test('a date is YYYY-MM-DD or a serial, and a locale-rendered one is refused', () => {
  const v = sheetOf(data());
  // Text typed by a human. Guessing between DD/MM and MM/DD lands a date four months out.
  type_(v, 'Tickets', 2, 'waiting since', '4/8/2026');
  expect(plan(data(), v).problems[0].message).toContain('not a date');

  type_(v, 'Tickets', 2, 'waiting since', '2026-08-04');
  expect(plan(data(), v).changes[0].patch.waitingSince).toBe('2026-08-04');

  // A real date cell arrives as a serial from the 1899-12-30 epoch.
  type_(v, 'Tickets', 2, 'waiting since', 46_238, '04/08/2026');
  expect(plan(data(), v).changes[0].patch.waitingSince).toBe('2026-08-04');
});

test('the serial epoch is 1899-12-30, and off-by-one is a date four months out', () => {
  expect(fromSerial(46_238)).toBe('2026-08-04');
  expect(fromSerial(1)).toBe('1899-12-31');
  expect(fromSerial(46_238.75)).toBe('2026-08-04'); // a datetime cell is still that day
});

test('blanking an optional field clears it; blanking a required one is refused', () => {
  const v = sheetOf(data());
  type_(v, 'Customers', 2, 'notes', '');
  expect(plan(data(), v).changes[0].patch).toEqual({ notes: '' });

  const w = sheetOf(data());
  type_(w, 'Tickets', 2, 'title', '');
  expect(plan(data(), w).problems[0].message).toContain('cannot be empty');
  expect(plan(data(), w).refusal).not.toBeNull();
});

test('a value STEWARD itself wrote is never validated', () => {
  // The safety net under every rule above: a cell holding exactly what the push wrote is
  // unchanged by definition, so a validator that dislikes the app's own stored value can
  // never refuse a pull nobody asked for.
  const odd = ticket({ waitingSince: '2026-07-10T09:30:00.000Z' });
  const d = data({ tickets: [odd] });
  expect(plan(d, sheetOf(d)).problems).toEqual([]);
  expect(plan(d, sheetOf(d)).changes).toEqual([]);
});

// --- the columns that are not fields ---------------------------------------

test('editing a derived column proposes nothing', () => {
  const v = sheetOf(data());
  type_(v, 'Tickets', 2, 'client code', 'OTHER'); // would read as a re-parent
  type_(v, 'Tickets', 2, 'customer', 'Someone, Else');
  type_(v, 'Tickets', 2, 'last updated', '2026-01-01');
  type_(v, 'Customers', 2, 'archived', '2026-08-04'); // archiving is a verb, not a cell
  type_(v, 'Customers', 2, 'customer code', 'NEWX'); // it is baked into every ticket id
  type_(v, 'Clients', 2, 'code', 'NEW');

  expect(plan(data(), v).changes).toEqual([]);
});

test('a mirror missing 0011 columns refuses rather than keying on position', () => {
  const v = sheetOf(data());
  v.Customers!.text[1] = ['id', 'client code', 'customer code', 'persons', 'email'];
  const p = plan(data(), v);
  expect(p.refusal).toContain('missing');
  expect(p.refusal).toContain('Push first');
});

// --- persons, the hole 0010's join left ------------------------------------

test('a misspelled surname is fixable, which is the point', () => {
  const v = sheetOf(data());
  type_(v, 'Customers', 2, 'family', 'Doughty');

  const p = plan(data(), v);
  expect(p.changes[0].fields).toEqual([{ header: 'family', from: 'Doe', to: 'Doughty' }]);
  expect(p.changes[0].patch.persons).toEqual([{ given: 'Jane', family: 'Doughty' }]);
});

test('clearing half of a second person drops the whole of them, and the preview says so', () => {
  const joint = customer({ persons: [{ given: 'Jane', family: 'Doe' }, { given: 'Emma', family: 'Reed' }] });
  const d = data({ customers: [joint] });
  const v = sheetOf(d);
  type_(v, 'Customers', 2, 'family 2', '');

  const p = plan(d, v);
  // The diff is of the RESULT, not the cells: showing only the cleared cell would be lying
  // about what apply does, since a second person exists only when BOTH halves do.
  expect(p.changes[0].fields).toEqual([
    { header: 'given 2', from: 'Emma', to: '' },
    { header: 'family 2', from: 'Reed', to: '' },
  ]);
  expect(p.changes[0].patch.persons).toEqual([{ given: 'Jane', family: 'Doe' }]);
});

// --- the ids, and the paste no algorithm finds ------------------------------

test('a duplicated id fails the whole pull', () => {
  const v = sheetOf(data());
  v.Tickets!.raw.push([...v.Tickets!.raw[2]]);
  v.Tickets!.text.push([...v.Tickets!.text[2]]);

  // There is no defensible way to choose between two rows claiming the same record.
  expect(plan(data(), v).refusal).toContain('two rows for the same record id');
});

test('an id STEWARD does not know is skipped and reported, never silently dropped', () => {
  const v = sheetOf(data());
  v.Tickets!.raw.push(['t_ghost', 'TX0009', '', '', 'Ghost', 'Waiting', '', '', '', '', '', '']);
  v.Tickets!.text.push(['t_ghost', 'TX0009', '', '', 'Ghost', 'Waiting', '', '', '', '', '', '']);

  const p = plan(data(), v);
  expect(p.unknown).toEqual([{ tab: 'Tickets', id: 't_ghost', row: 4 }]);
  expect(p.changes).toEqual([]);
  expect(p.refusal).toBeNull(); // a record can legitimately have gone
});

test('pointing at a different spreadsheet entirely is refused outright', () => {
  const v = sheetOf(data());
  for (const tab of PULL_TABS) {
    for (const rows of [v[tab]!.raw, v[tab]!.text]) {
      for (let i = 2; i < rows.length; i += 1) rows[i][0] = `other_${i}`;
    }
  }
  // The one case where a partial answer is worse than none.
  expect(plan(data(), v).refusal).toContain('wrong file');
});

test('the shifted paste is not detected — it is SHOWN, and it trips the blast radius', () => {
  // Every id is real and every value is somebody else's. Nothing in the data distinguishes
  // this from a legitimate bulk edit; only a human reading the list does.
  const tickets = Array.from({ length: 12 }, (_, i) =>
    ticket({ id: `t_${i}`, ticketId: `TX${i}`, title: `Title ${i}`, nextAction: `Action ${i}` }));
  const d = { clients: [], customers: [], tickets };
  const v = sheetOf(d);
  const titleCol = headersFor('Tickets').indexOf('title');
  for (const rows of [v.Tickets!.raw, v.Tickets!.text]) {
    for (let i = rows.length - 1; i > 2; i -= 1) rows[i][titleCol] = rows[i - 1][titleCol];
  }

  const p = plan(d, v);
  expect(p.changes.length).toBe(11);
  expect(p.needsAck).toBe(true);
  expect(p.refusal).toBeNull(); // a bulk edit is legitimate; a human decides which this is
});

test('a small edit needs no second confirmation, however small the workspace', () => {
  // The bare quarter-of-the-records fraction demands a confirmation for editing one cell in
  // a three-record workspace, and a speed bump that fires on ordinary work is one the
  // operator learns to click through — costing exactly the case it exists for.
  const v = sheetOf(data());
  type_(v, 'Tickets', 2, 'summary', 'a new summary');
  expect(plan(data(), v).needsAck).toBe(false);
});

// --- the conflict that "the sheet wins" exists to settle --------------------

test('a record changed in STEWARD since the push is flagged, and still overwritten', () => {
  const d = data({ tickets: [ticket({ updatedAt: '2026-08-02T09:00:00.000Z' })] });
  const v = sheetOf(d);
  type_(v, 'Tickets', 2, 'summary', 'from the sheet');

  const p = plan(d, v, AT);
  expect(p.changes[0].conflict).toBe(true);
  expect(p.changes[0].patch.summary).toBe('from the sheet');
  // A record untouched in STEWARD since the push is not flagged, or the flag means nothing.
  expect(plan(data(), v).changes[0].conflict).toBe(false);
});

// --- applying ---------------------------------------------------------------

function writerSpy() {
  const calls: { kind: string; id: string; patch: Record<string, unknown>; by: string; diff: unknown }[] = [];
  let depth = 0;
  let maxDepth = 0;
  const record = (kind: string) => (id: string, patch: Record<string, unknown>, by: string, diff?: unknown) => {
    if (depth === 0) throw new Error('a write escaped the transaction');
    calls.push({ kind, id, patch, by, diff });
  };
  const writer: PullWriter = {
    transaction: (fn) => { depth += 1; maxDepth = Math.max(maxDepth, depth); try { return fn(); } finally { depth -= 1; } },
    updateClient: record('client'),
    updateCustomer: record('customer'),
    updateTicket: record('ticket'),
  };
  return { writer, calls, wrapped: () => maxDepth === 1 };
}

test('every write lands inside one transaction, as the actor the sheet supplies', () => {
  const v = sheetOf(data());
  type_(v, 'Clients', 2, 'name', 'Acme Holdings');
  type_(v, 'Customers', 2, 'phone', '556');
  type_(v, 'Tickets', 2, 'summary', 'new');

  const spy = writerSpy();
  const applied = applyPull(spy.writer, plan(data(), v), 'sheet:op@example.com');

  expect(applied).toBe(3);
  expect(spy.wrapped()).toBe(true);
  expect(spy.calls.map((c) => c.kind)).toEqual(['client', 'customer', 'ticket']);
  expect(spy.calls.every((c) => c.by === 'sheet:op@example.com')).toBe(true);
});

test('a pull stamps a ticket\'s last-updated but keeps it out of the audit diff', () => {
  const v = sheetOf(data());
  type_(v, 'Tickets', 2, 'summary', 'new');

  const spy = writerSpy();
  applyPull(spy.writer, plan(data(), v), 'sheet:x');

  expect(spy.calls[0].patch.dateLastUpdated).toBeTruthy();
  // One edited cell must not read as "2 details changed" in the operator's own history.
  expect(spy.calls[0].diff).toEqual({ summary: 'new' });
});

test('a refused plan cannot be applied at all', () => {
  const v = sheetOf(data());
  type_(v, 'Tickets', 2, 'status', 'Nope');
  const spy = writerSpy();
  expect(() => applyPull(spy.writer, plan(data(), v), 'sheet:x')).toThrow();
  expect(spy.calls).toEqual([]);
});

test('A1 notation, so a problem names a cell the operator can go and find', () => {
  expect([0, 5, 25, 26, 27].map(columnLetter)).toEqual(['A', 'F', 'Z', 'AA', 'AB']);
});

// --- the fingerprint that replaced Drive's clock ----------------------------

test('the fingerprint moves when the diff moves, and only then', () => {
  const v = sheetOf(data());
  type_(v, 'Tickets', 2, 'summary', 'one');
  const a = planFingerprint(plan(data(), v));

  // Re-reading the same sheet is the same diff, so an apply after a preview proceeds.
  expect(planFingerprint(plan(data(), v))).toBe(a);

  // Somebody with the share link types while the preview is on screen.
  type_(v, 'Tickets', 2, 'summary', 'two');
  expect(planFingerprint(plan(data(), v))).not.toBe(a);

  // ...and so does a change on the OTHER side: the database moved instead.
  type_(v, 'Tickets', 2, 'summary', 'one');
  const moved = data({ tickets: [ticket({ summary: 'changed in the app' })] });
  expect(planFingerprint(plan(moved, v))).not.toBe(a);
});

test('a problem changes the fingerprint, so a newly-broken cell is never applied past', () => {
  const v = sheetOf(data());
  type_(v, 'Tickets', 2, 'summary', 'one');
  const a = planFingerprint(plan(data(), v));
  type_(v, 'Tickets', 2, 'status', 'Nope');
  expect(planFingerprint(plan(data(), v))).not.toBe(a);
});
