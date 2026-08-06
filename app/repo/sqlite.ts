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
  AuditRepository,
  ClientRepository,
  CustomerRepository,
  DocumentRepository,
  NewClient,
  NewCustomer,
  NewDocument,
  NewTicket,
  Repositories,
  SettingsRepository,
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

  list(scope: ListScope = 'live'): Client[] {
    return this.d.query<ClientRow, []>(
      `SELECT * FROM clients WHERE ${scopeSql(scope, ['archivedAt'])} ORDER BY name`,
    ).all().map(toClient);
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

  list(clientId?: string, scope: ListScope = 'live'): Customer[] {
    const where = scopeSql(scope, ['c.archivedAt', 'cl.archivedAt']);
    const sql = `SELECT c.* FROM customers c JOIN clients cl ON cl.id = c.clientId
                 WHERE ${where}${clientId ? ' AND c.clientId = ?' : ''} ORDER BY c.code`;
    const rows = clientId
      ? this.d.query<CustomerRow, [string]>(sql).all(clientId)
      : this.d.query<CustomerRow, []>(sql).all();
    return rows.map(toCustomer);
  }
  get(id: string): Customer | null {
    const r = this.d.query<CustomerRow, [string]>('SELECT * FROM customers WHERE id = ?').get(id);
    return r ? toCustomer(r) : null;
  }
  search(query: string, scope: ListScope = 'live'): Customer[] {
    const like = `%${query.toLowerCase()}%`;
    return this.d.query<CustomerRow, [string, string, string]>(
      `SELECT c.* FROM customers c JOIN clients cl ON cl.id = c.clientId
       WHERE ${scopeSql(scope, ['c.archivedAt', 'cl.archivedAt'])}
         AND (lower(c.persons) LIKE ? OR lower(c.email) LIKE ? OR lower(c.code) LIKE ?)
       ORDER BY c.code LIMIT 50`,
    ).all(like, like, like).map(toCustomer);
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

  list(customerId?: string, scope: ListScope = 'live'): Ticket[] {
    // Two joins, because a ticket is hidden by EITHER ancestor. There is no `tickets.archivedAt`
    // on purpose: the human asked to archive customers and clients, and a ticket that is
    // finished already has a status that says so.
    const where = scopeSql(scope, ['cu.archivedAt', 'cl.archivedAt']);
    const sql = `SELECT t.* FROM tickets t
                 JOIN customers cu ON cu.id = t.customerId
                 JOIN clients cl ON cl.id = cu.clientId
                 WHERE ${where}${customerId ? ' AND t.customerId = ?' : ''}
                 ORDER BY t.createdAt DESC`;
    const rows = customerId
      ? this.d.query<TicketRow, [string]>(sql).all(customerId)
      : this.d.query<TicketRow, []>(sql).all();
    return rows.map(toTicket);
  }
  get(id: string): Ticket | null {
    const r = this.d.query<TicketRow, [string]>('SELECT * FROM tickets WHERE id = ?').get(id);
    return r ? toTicket(r) : null;
  }
  byStatus(): Record<string, Ticket[]> {
    const out: Record<string, Ticket[]> = {};
    for (const t of this.list()) (out[t.status] ??= []).push(t);
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
}

// --- documents --------------------------------------------------------------

class SqliteDocumentRepository implements DocumentRepository {
  constructor(private d: Database) {}

  list(): DocumentRef[] {
    return this.d.query<DocumentRef, []>(
      'SELECT * FROM documents ORDER BY createdAt DESC',
    ).all();
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
  };
}
