// SQLite implementations of the repository ports. Source of truth.

import type { Database } from 'bun:sqlite';
import { db, nextTicketSeq } from './db.ts';
import { newId, makeTicketId, customerCodeFromPersons } from '../ids.ts';
import type {
  AuditEntry,
  Client,
  Customer,
  DocumentRef,
  ListScope,
  Ticket,
} from '../domain/types.ts';
import type {
  AuditQuery,
  AuditRepository,
  ClientQuery,
  ClientRepository,
  CustomerQuery,
  CustomerRepository,
  DocumentQuery,
  DocumentRepository,
  NewClient,
  NewCustomer,
  NewDocument,
  NewTicket,
  Repositories,
  SettingsRepository,
  TicketQuery,
  TicketRepository,
} from './ports.ts';

const now = (): string => new Date().toISOString();

// --- row <-> domain mappers ------------------------------------------------

interface ClientRow {
  id: string; name: string; code: string; branding: string;
  archivedAt: string | null; createdAt: string; updatedAt: string;
}
const toClient = (r: ClientRow): Client => ({
  id: r.id, name: r.name, code: r.code,
  branding: JSON.parse(r.branding),
  archivedAt: r.archivedAt,
  createdAt: r.createdAt, updatedAt: r.updatedAt,
});

interface CustomerRow {
  id: string; clientId: string; code: string; persons: string;
  email: string; phone: string; externalId: string; notes: string;
  archivedAt: string | null; createdAt: string; updatedAt: string;
}
const toCustomer = (r: CustomerRow): Customer => ({
  id: r.id, clientId: r.clientId, code: r.code,
  persons: JSON.parse(r.persons),
  email: r.email, phone: r.phone, externalId: r.externalId, notes: r.notes,
  archivedAt: r.archivedAt,
  createdAt: r.createdAt, updatedAt: r.updatedAt,
});

/**
 * The visibility predicate, as SQL, once — because there are a dozen callers and every one
 * that forgot would be a leak. The digest is the surface where forgetting is invisible until
 * a real morning email carries an archived customer's ticket.
 *
 * `live` is the whole lineage being unarchived. `archived` is its negation, which is what
 * makes the archived view show a client's customers as well as the clients themselves.
 */
const scopeSql = (scope: ListScope, cols: string[]): string => {
  if (scope === 'all') return '1=1';
  const live = cols.map((c) => `${c} IS NULL`).join(' AND ');
  return scope === 'live' ? live : `NOT (${live})`;
};

type Param = string | number;

/**
 * A WHERE clause under construction (0014): predicates AND'd together, values in order.
 *
 * `scopeSql` stays exactly as 0012 wrote it and the rest of the clause is composed BESIDE
 * it — same function, more predicates, still one place. The point of the little class is
 * that a clause and its bound values are added in the same call, so they cannot drift out
 * of step, which is the only way a hand-built parameter list ever goes wrong.
 *
 * An absent or empty facet adds nothing at all. "No filter" and "filter matching nothing"
 * are different questions and only one of them is what an unchecked chip means.
 */
class Where {
  readonly parts: string[] = [];
  readonly params: Param[] = [];

  add(clause: string, ...values: Param[]): this {
    this.parts.push(clause);
    this.params.push(...values);
    return this;
  }
  eq(col: string, value: string | undefined): this {
    return value ? this.add(`${col} = ?`, value) : this;
  }
  /** `col IN (?,?,…)`. Placeholders, never interpolation — these are values. */
  in(col: string, values: readonly string[] | undefined): this {
    if (!values?.length) return this;
    return this.add(`${col} IN (${values.map(() => '?').join(',')})`, ...values);
  }
  /** `lower(a) LIKE ? OR lower(b) LIKE ?` — the same needle bound once per column. */
  like(cols: string[], q: string | undefined): this {
    const needle = (q ?? '').trim().toLowerCase();
    if (!needle) return this;
    return this.add(
      `(${cols.map((c) => `lower(${c}) LIKE ?`).join(' OR ')})`,
      ...cols.map(() => `%${needle}%`),
    );
  }
  clause(): string {
    return this.parts.length ? this.parts.join(' AND ') : '1=1';
  }
}

/**
 * The columns a `q` searches, per list — deliberately the columns the LIST SHOWS.
 *
 * The topbar box narrows what is on screen by matching `textContent`; the server matches
 * these. If the two sets disagree, typing the same word twice gives two different answers,
 * which is worse than either one alone.
 */
const CLIENT_Q_COLS = ['name', 'code', `json_extract(branding,'$.companyInfo')`];
const CUSTOMER_Q_COLS = ['c.persons', 'c.email', 'c.code'];
const TICKET_Q_COLS = ['t.title', 't.ticketId', 't.summary', 't.waitingOn', 'cu.persons'];

interface TicketRow {
  id: string; customerId: string; ticketId: string; title: string;
  dateInitiated: string; status: string; dateLastUpdated: string;
  waitingOn: string; waitingSince: string; summary: string; nextAction: string;
  progressLog: string; commRefs: string; createdAt: string; updatedAt: string;
}
const toTicket = (r: TicketRow): Ticket => ({
  id: r.id, customerId: r.customerId, ticketId: r.ticketId, title: r.title,
  dateInitiated: r.dateInitiated, status: r.status as Ticket['status'],
  dateLastUpdated: r.dateLastUpdated, waitingOn: r.waitingOn,
  waitingSince: r.waitingSince, summary: r.summary, nextAction: r.nextAction,
  progressLog: JSON.parse(r.progressLog), commRefs: JSON.parse(r.commRefs),
  createdAt: r.createdAt, updatedAt: r.updatedAt,
});

// --- clients ---------------------------------------------------------------

class SqliteClientRepository implements ClientRepository {
  constructor(private d: Database) {}

  list(query: ClientQuery = {}): Client[] {
    const w = new Where()
      .add(scopeSql(query.scope ?? 'live', ['archivedAt']))
      .like(CLIENT_Q_COLS, query.q);
    return this.d.query<ClientRow, Param[]>(
      `SELECT * FROM clients WHERE ${w.clause()} ORDER BY name`,
    ).all(...w.params).map(toClient);
  }
  get(id: string): Client | null {
    const r = this.d.query<ClientRow, [string]>('SELECT * FROM clients WHERE id = ?').get(id);
    return r ? toClient(r) : null;
  }
  create(input: NewClient): Client {
    const c: Client = { ...input, id: newId('cli'), archivedAt: null, createdAt: now(), updatedAt: now() };
    this.d.run(
      `INSERT INTO clients (id,name,code,branding,createdAt,updatedAt)
       VALUES (?,?,?,?,?,?)`,
      [c.id, c.name, c.code, JSON.stringify(c.branding), c.createdAt, c.updatedAt],
    );
    return c;
  }
  update(id: string, patch: Partial<NewClient>): Client {
    const cur = this.get(id);
    if (!cur) throw new Error(`client not found: ${id}`);
    const next: Client = { ...cur, ...patch, id, updatedAt: now() };
    this.d.run(
      `UPDATE clients SET name=?,code=?,branding=?,updatedAt=? WHERE id=?`,
      [next.name, next.code, JSON.stringify(next.branding), next.updatedAt, id],
    );
    return next;
  }
  setArchived(id: string, at: string | null): Client {
    const cur = this.get(id);
    if (!cur) throw new Error(`client not found: ${id}`);
    // `updatedAt` deliberately does NOT move: archiving is not an edit of the record, and
    // the digest and the sheet both read that field as "when did this last change".
    this.d.run('UPDATE clients SET archivedAt=? WHERE id=?', [at, id]);
    return { ...cur, archivedAt: at };
  }
  remove(id: string): void {
    this.d.run('DELETE FROM clients WHERE id = ?', [id]);
  }
}

// --- customers -------------------------------------------------------------

class SqliteCustomerRepository implements CustomerRepository {
  constructor(private d: Database) {}

  list(query: CustomerQuery = {}): Customer[] {
    const w = new Where()
      .add(scopeSql(query.scope ?? 'live', ['c.archivedAt', 'cl.archivedAt']))
      .eq('c.clientId', query.clientId)
      .like(CUSTOMER_Q_COLS, query.q);
    return this.d.query<CustomerRow, Param[]>(
      `SELECT c.* FROM customers c JOIN clients cl ON cl.id = c.clientId
       WHERE ${w.clause()} ORDER BY c.code`,
    ).all(...w.params).map(toCustomer);
  }
  get(id: string): Customer | null {
    const r = this.d.query<CustomerRow, [string]>('SELECT * FROM customers WHERE id = ?').get(id);
    return r ? toCustomer(r) : null;
  }
  /**
   * The capped type-ahead. Same predicate as `list({ q })` — built from the same columns —
   * with a ceiling, because this one answers a keystroke rather than a page.
   */
  search(query: string, scope: ListScope = 'live'): Customer[] {
    const w = new Where()
      .add(scopeSql(scope, ['c.archivedAt', 'cl.archivedAt']))
      .like(CUSTOMER_Q_COLS, query);
    return this.d.query<CustomerRow, Param[]>(
      `SELECT c.* FROM customers c JOIN clients cl ON cl.id = c.clientId
       WHERE ${w.clause()} ORDER BY c.code LIMIT 50`,
    ).all(...w.params).map(toCustomer);
  }
  create(input: NewCustomer): Customer {
    const code = input.code || customerCodeFromPersons(input.persons);
    const c: Customer = { ...input, code, id: newId('cus'), archivedAt: null, createdAt: now(), updatedAt: now() };
    this.d.run(
      `INSERT INTO customers (id,clientId,code,persons,email,phone,externalId,notes,createdAt,updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [c.id, c.clientId, c.code, JSON.stringify(c.persons), c.email, c.phone, c.externalId, c.notes, c.createdAt, c.updatedAt],
    );
    return c;
  }
  update(id: string, patch: Partial<NewCustomer>): Customer {
    const cur = this.get(id);
    if (!cur) throw new Error(`customer not found: ${id}`);
    const next: Customer = { ...cur, ...patch, id, updatedAt: now() };
    this.d.run(
      `UPDATE customers SET clientId=?,code=?,persons=?,email=?,phone=?,externalId=?,notes=?,updatedAt=? WHERE id=?`,
      [next.clientId, next.code, JSON.stringify(next.persons), next.email, next.phone, next.externalId, next.notes, next.updatedAt, id],
    );
    return next;
  }
  setArchived(id: string, at: string | null): Customer {
    const cur = this.get(id);
    if (!cur) throw new Error(`customer not found: ${id}`);
    this.d.run('UPDATE customers SET archivedAt=? WHERE id=?', [at, id]);
    return { ...cur, archivedAt: at };
  }
  remove(id: string): void {
    this.d.run('DELETE FROM customers WHERE id = ?', [id]);
  }
}

// --- tickets ---------------------------------------------------------------

class SqliteTicketRepository implements TicketRepository {
  constructor(private d: Database) {}

  list(query: TicketQuery = {}): Ticket[] {
    // Two joins, because a ticket is hidden by EITHER ancestor. There is no `tickets.archivedAt`
    // on purpose: the human asked to archive customers and clients, and a ticket that is
    // finished already has a status that says so.
    //
    // Those same two joins are what makes `clientId` free: "this client's tickets" is a
    // predicate on a table the query was already reading.
    const w = new Where()
      .add(scopeSql(query.scope ?? 'live', ['cu.archivedAt', 'cl.archivedAt']))
      .eq('t.customerId', query.customerId)
      .eq('cu.clientId', query.clientId)
      .in('t.status', query.status)
      .like(TICKET_Q_COLS, query.q);
    return this.d.query<TicketRow, Param[]>(
      `SELECT t.* FROM tickets t
       JOIN customers cu ON cu.id = t.customerId
       JOIN clients cl ON cl.id = cu.clientId
       WHERE ${w.clause()} ORDER BY t.createdAt DESC`,
    ).all(...w.params).map(toTicket);
  }
  get(id: string): Ticket | null {
    const r = this.d.query<TicketRow, [string]>('SELECT * FROM tickets WHERE id = ?').get(id);
    return r ? toTicket(r) : null;
  }
  byStatus(query: TicketQuery = {}): Record<string, Ticket[]> {
    const out: Record<string, Ticket[]> = {};
    for (const t of this.list(query)) (out[t.status] ??= []).push(t);
    return out;
  }
  create(input: NewTicket): Ticket {
    const customer = this.d
      .query<CustomerRow, [string]>('SELECT * FROM customers WHERE id = ?')
      .get(input.customerId);
    if (!customer) throw new Error(`customer not found: ${input.customerId}`);
    const code = toCustomer(customer).code;
    const seq = nextTicketSeq(this.d, input.customerId);
    const t: Ticket = {
      ...input,
      id: newId('tkt'),
      ticketId: makeTicketId(code, seq),
      createdAt: now(),
      updatedAt: now(),
    };
    this.d.run(
      `INSERT INTO tickets
       (id,customerId,ticketId,title,dateInitiated,status,dateLastUpdated,waitingOn,waitingSince,summary,nextAction,progressLog,commRefs,createdAt,updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [t.id, t.customerId, t.ticketId, t.title, t.dateInitiated, t.status, t.dateLastUpdated,
       t.waitingOn, t.waitingSince, t.summary, t.nextAction,
       JSON.stringify(t.progressLog), JSON.stringify(t.commRefs), t.createdAt, t.updatedAt],
    );
    return t;
  }
  update(id: string, patch: Partial<NewTicket>): Ticket {
    const cur = this.get(id);
    if (!cur) throw new Error(`ticket not found: ${id}`);
    const next: Ticket = { ...cur, ...patch, id, updatedAt: now() };
    this.d.run(
      `UPDATE tickets SET title=?,dateInitiated=?,status=?,dateLastUpdated=?,waitingOn=?,waitingSince=?,summary=?,nextAction=?,progressLog=?,commRefs=?,updatedAt=? WHERE id=?`,
      [next.title, next.dateInitiated, next.status, next.dateLastUpdated, next.waitingOn,
       next.waitingSince, next.summary, next.nextAction,
       JSON.stringify(next.progressLog), JSON.stringify(next.commRefs), next.updatedAt, id],
    );
    return next;
  }
  remove(id: string): void {
    this.d.run('DELETE FROM tickets WHERE id = ?', [id]);
  }
}

// --- audit -----------------------------------------------------------------

class SqliteAuditRepository implements AuditRepository {
  constructor(private d: Database) {}

  append(entry: Omit<AuditEntry, 'id' | 'at'>): AuditEntry {
    const e: AuditEntry = { ...entry, id: newId('aud'), at: now() };
    this.d.run(
      `INSERT INTO audit (id,entity,entityId,action,actor,at,diff) VALUES (?,?,?,?,?,?,?)`,
      [e.id, e.entity, e.entityId, e.action, e.actor, e.at, e.diff],
    );
    return e;
  }
  forEntity(entity: string, entityId: string): AuditEntry[] {
    return this.d.query<AuditEntry, [string, string]>(
      'SELECT * FROM audit WHERE entity = ? AND entityId = ? ORDER BY at DESC',
    ).all(entity, entityId);
  }
  recent(limit = 100): AuditEntry[] {
    return this.d.query<AuditEntry, [number]>(
      'SELECT * FROM audit ORDER BY at DESC LIMIT ?',
    ).all(limit);
  }

  /**
   * The FROM clause every filtered audit read shares (0014).
   *
   * The three left joins are what let `q` match a record's NAME. An audit row stores an
   * entity and an id, and nobody has ever searched for an id — so without them "filter the
   * activity by this customer" is a question the trail cannot answer, which is exactly the
   * gap `/activity` was papering over by filtering two hundred rows in the DOM.
   *
   * LEFT, not inner: the trail outlives the records it points at, and a deleted record's
   * history is still history.
   *
   * The trail is never scoped. 0012 was explicit — "an archived record's history is exactly
   * what someone asks for later" — and nothing here changes it.
   */
  private static readonly FROM = `FROM audit a
     LEFT JOIN clients   cl ON a.entity = 'client'   AND cl.id = a.entityId
     LEFT JOIN customers cu ON a.entity = 'customer' AND cu.id = a.entityId
     LEFT JOIN tickets   t  ON a.entity = 'ticket'   AND t.id  = a.entityId`;

  private static where(q: AuditQuery): Where {
    return new Where()
      .in('a.entity', q.entity)
      .in('a.action', q.action)
      .in('a.actor', q.actor)
      // `at` is a full ISO timestamp; the bounds are dates. `>= 'YYYY-MM-DD'` and
      // `<= 'YYYY-MM-DD' || 'Z'` (which sorts after every time on that day) make BOTH
      // ends inclusive, which is what a reader of a date range expects.
      .add(q.from ? 'a.at >= ?' : '1=1', ...(q.from ? [q.from] : []))
      .add(q.to ? 'a.at <= ?' : '1=1', ...(q.to ? [`${q.to}Z`] : []))
      .like(['a.actor', 'cl.name', 'cu.persons', 'cu.email', 't.title', 't.ticketId'], q.q);
  }

  query(q: AuditQuery = {}): AuditEntry[] {
    const w = SqliteAuditRepository.where(q);
    // The limit is applied AFTER the predicate. `recent(200)` did it the other way round,
    // which is how "Showing 3 of 200" came to describe the last two hundred rows rather
    // than the trail — a wrong answer, delivered confidently.
    const limit = q.limit ?? 200;
    return this.d.query<AuditEntry, Param[]>(
      `SELECT a.* ${SqliteAuditRepository.FROM} WHERE ${w.clause()} ORDER BY a.at DESC LIMIT ?`,
    ).all(...w.params, limit);
  }

  count(q: AuditQuery = {}): number {
    const w = SqliteAuditRepository.where(q);
    return this.d.query<{ n: number }, Param[]>(
      `SELECT count(*) AS n ${SqliteAuditRepository.FROM} WHERE ${w.clause()}`,
    ).get(...w.params)?.n ?? 0;
  }

  actors(): string[] {
    return this.d.query<{ actor: string }, []>(
      'SELECT DISTINCT actor FROM audit ORDER BY actor',
    ).all().map((r) => r.actor);
  }
}

// --- documents --------------------------------------------------------------

class SqliteDocumentRepository implements DocumentRepository {
  constructor(private d: Database) {}

  list(query: DocumentQuery = {}): DocumentRef[] {
    // No scope facet, deliberately (0012): "the documents are still real files in Drive; a
    // document list that silently shortens is worse than one that shows where a file came
    // from." `/files` is an index of bytes, not a view of live records.
    const w = new Where()
      .in('source', query.source)
      .in('storage', query.storage)
      .like(['name', 'mimeType'], query.q);
    return this.d.query<DocumentRef, Param[]>(
      `SELECT * FROM documents WHERE ${w.clause()} ORDER BY createdAt DESC`,
    ).all(...w.params);
  }
  forEntity(entity: string, entityId: string): DocumentRef[] {
    return this.d.query<DocumentRef, [string, string]>(
      'SELECT * FROM documents WHERE entity = ? AND entityId = ? ORDER BY createdAt DESC',
    ).all(entity, entityId);
  }
  /**
   * The same read for many records at once (0013). The daily digest wants the
   * documents of every pending ticket, and one query per ticket is a query per
   * ticket. `idx_documents_entity` covers `(entity, entityId)`, so an `IN` list
   * uses the same index the single-entity read does.
   */
  forEntities(entity: string, entityIds: string[]): Map<string, DocumentRef[]> {
    const out = new Map<string, DocumentRef[]>();
    if (!entityIds.length) return out;
    // Placeholders rather than interpolation — these are ids, but they are still
    // values, and there is no such thing as a value this file trusts.
    const holes = entityIds.map(() => '?').join(',');
    const rows = this.d.query<DocumentRef, string[]>(
      `SELECT * FROM documents WHERE entity = ? AND entityId IN (${holes}) ORDER BY createdAt DESC`,
    ).all(entity, ...entityIds);
    for (const r of rows) {
      const list = out.get(r.entityId);
      if (list) list.push(r); else out.set(r.entityId, [r]);
    }
    return out;
  }
  get(id: string): DocumentRef | null {
    return this.d.query<DocumentRef, [string]>(
      'SELECT * FROM documents WHERE id = ?',
    ).get(id) ?? null;
  }
  create(input: NewDocument): DocumentRef {
    const doc: DocumentRef = { ...input, id: newId('doc'), createdAt: now() };
    this.d.run(
      `INSERT INTO documents
         (id,entity,entityId,name,mimeType,size,source,storage,storageId,webViewLink,createdAt,createdBy)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [doc.id, doc.entity, doc.entityId, doc.name, doc.mimeType, doc.size,
        doc.source, doc.storage, doc.storageId, doc.webViewLink, doc.createdAt, doc.createdBy],
    );
    return doc;
  }
  remove(id: string): void {
    this.d.run('DELETE FROM documents WHERE id = ?', [id]);
  }
}

// --- settings ---------------------------------------------------------------

class SqliteSettingsRepository implements SettingsRepository {
  constructor(private d: Database) {}

  get(key: string): string | null {
    return this.d.query<{ value: string }, [string]>(
      'SELECT value FROM settings WHERE key = ?',
    ).get(key)?.value ?? null;
  }
  set(key: string, value: string): void {
    this.d.run(
      `INSERT INTO settings (key,value) VALUES (?,?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }
  remove(key: string): void {
    this.d.run('DELETE FROM settings WHERE key = ?', [key]);
  }
  /** Keys only. The values are read one at a time through `get`, like everything else. */
  keys(): string[] {
    return this.d.query<{ key: string }, []>(
      'SELECT key FROM settings ORDER BY key',
    ).all().map((r) => r.key);
  }
}

// --- factory ---------------------------------------------------------------

export function sqliteRepositories(database: Database = db()): Repositories {
  return {
    clients: new SqliteClientRepository(database),
    customers: new SqliteCustomerRepository(database),
    tickets: new SqliteTicketRepository(database),
    audit: new SqliteAuditRepository(database),
    documents: new SqliteDocumentRepository(database),
    settings: new SqliteSettingsRepository(database),
    // The same `Database.transaction` the migration ladder already runs on (db.ts).
    // `transaction()` returns a function; calling it is what opens and commits.
    transaction: <T>(fn: () => T): T => database.transaction(fn)(),
  };
}
