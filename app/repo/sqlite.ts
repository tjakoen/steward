// SQLite implementations of the repository ports. Source of truth.

import type { Database } from 'bun:sqlite';
import { db, nextTicketSeq } from './db.ts';
import { newId, makeTicketId, customerCodeFromPersons } from '../ids.ts';
import type {
  AuditEntry,
  Client,
  Customer,
  DocumentRef,
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
  TicketRepository,
} from './ports.ts';

const now = (): string => new Date().toISOString();

// --- row <-> domain mappers ------------------------------------------------

interface ClientRow {
  id: string; name: string; code: string; branding: string;
  active: number; createdAt: string; updatedAt: string;
}
const toClient = (r: ClientRow): Client => ({
  id: r.id, name: r.name, code: r.code,
  branding: JSON.parse(r.branding),
  active: r.active === 1,
  createdAt: r.createdAt, updatedAt: r.updatedAt,
});

interface CustomerRow {
  id: string; clientId: string; code: string; persons: string;
  email: string; phone: string; externalId: string; notes: string;
  createdAt: string; updatedAt: string;
}
const toCustomer = (r: CustomerRow): Customer => ({
  id: r.id, clientId: r.clientId, code: r.code,
  persons: JSON.parse(r.persons),
  email: r.email, phone: r.phone, externalId: r.externalId, notes: r.notes,
  createdAt: r.createdAt, updatedAt: r.updatedAt,
});

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

  list(): Client[] {
    return this.d.query<ClientRow, []>('SELECT * FROM clients ORDER BY name')
      .all().map(toClient);
  }
  get(id: string): Client | null {
    const r = this.d.query<ClientRow, [string]>('SELECT * FROM clients WHERE id = ?').get(id);
    return r ? toClient(r) : null;
  }
  create(input: NewClient): Client {
    const c: Client = { ...input, id: newId('cli'), createdAt: now(), updatedAt: now() };
    this.d.run(
      `INSERT INTO clients (id,name,code,branding,active,createdAt,updatedAt)
       VALUES (?,?,?,?,?,?,?)`,
      [c.id, c.name, c.code, JSON.stringify(c.branding), c.active ? 1 : 0, c.createdAt, c.updatedAt],
    );
    return c;
  }
  update(id: string, patch: Partial<NewClient>): Client {
    const cur = this.get(id);
    if (!cur) throw new Error(`client not found: ${id}`);
    const next: Client = { ...cur, ...patch, id, updatedAt: now() };
    this.d.run(
      `UPDATE clients SET name=?,code=?,branding=?,active=?,updatedAt=? WHERE id=?`,
      [next.name, next.code, JSON.stringify(next.branding), next.active ? 1 : 0, next.updatedAt, id],
    );
    return next;
  }
  remove(id: string): void {
    this.d.run('DELETE FROM clients WHERE id = ?', [id]);
  }
}

// --- customers -------------------------------------------------------------

class SqliteCustomerRepository implements CustomerRepository {
  constructor(private d: Database) {}

  list(clientId?: string): Customer[] {
    const rows = clientId
      ? this.d.query<CustomerRow, [string]>('SELECT * FROM customers WHERE clientId = ? ORDER BY code').all(clientId)
      : this.d.query<CustomerRow, []>('SELECT * FROM customers ORDER BY code').all();
    return rows.map(toCustomer);
  }
  get(id: string): Customer | null {
    const r = this.d.query<CustomerRow, [string]>('SELECT * FROM customers WHERE id = ?').get(id);
    return r ? toCustomer(r) : null;
  }
  search(query: string): Customer[] {
    const like = `%${query.toLowerCase()}%`;
    return this.d.query<CustomerRow, [string, string, string]>(
      `SELECT * FROM customers
       WHERE lower(persons) LIKE ? OR lower(email) LIKE ? OR lower(code) LIKE ?
       ORDER BY code LIMIT 50`,
    ).all(like, like, like).map(toCustomer);
  }
  create(input: NewCustomer): Customer {
    const code = input.code || customerCodeFromPersons(input.persons);
    const c: Customer = { ...input, code, id: newId('cus'), createdAt: now(), updatedAt: now() };
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
  remove(id: string): void {
    this.d.run('DELETE FROM customers WHERE id = ?', [id]);
  }
}

// --- tickets ---------------------------------------------------------------

class SqliteTicketRepository implements TicketRepository {
  constructor(private d: Database) {}

  list(customerId?: string): Ticket[] {
    const rows = customerId
      ? this.d.query<TicketRow, [string]>('SELECT * FROM tickets WHERE customerId = ? ORDER BY createdAt DESC').all(customerId)
      : this.d.query<TicketRow, []>('SELECT * FROM tickets ORDER BY createdAt DESC').all();
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

// --- factory ---------------------------------------------------------------

export function sqliteRepositories(database: Database = db()): Repositories {
  return {
    clients: new SqliteClientRepository(database),
    customers: new SqliteCustomerRepository(database),
    tickets: new SqliteTicketRepository(database),
    audit: new SqliteAuditRepository(database),
    documents: new SqliteDocumentRepository(database),
  };
}
