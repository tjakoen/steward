// Repository ports. Services depend on these interfaces, not on SQLite.
// Swap the impl at the composition root (in-memory for tests, sqlite in prod).

import type {
  AuditAction,
  AuditEntity,
  AuditEntry,
  Client,
  Customer,
  DocumentRef,
  DocumentSource,
  DocumentStorage,
  ListScope,
  Ticket,
  TicketStatus,
} from '../domain/types.ts';

/**
 * The reads take a QUERY OBJECT, not a queue of optional positionals (0014).
 *
 * 0012 left `list(clientId?, scope?)` behind and this plan wanted four more predicates on
 * top of it; `list(undefined, 'live', undefined, 'Waiting')` is a bug waiting to be typed.
 * `scope` folds in and still defaults to `live`, so a caller that passes nothing still gets
 * the visibility rule 0012 put in SQL.
 *
 * `q` is a case-insensitive `LIKE` over the few columns the corresponding LIST SHOWS — the
 * server-side filter has to agree with the client-side one that reads `textContent`, or the
 * two disagree the moment both are live. Not FTS5: that is an index and a migration, for a
 * workspace that does not need one.
 */
export interface ClientQuery {
  scope?: ListScope;
  q?: string;
}
export interface CustomerQuery {
  scope?: ListScope;
  clientId?: string;
  q?: string;
}
export interface TicketQuery {
  scope?: ListScope;
  clientId?: string;
  customerId?: string;
  status?: TicketStatus[];
  q?: string;
}
export interface DocumentQuery {
  source?: DocumentSource[];
  storage?: DocumentStorage[];
  q?: string;
}
/**
 * The audit read that `/activity` always needed (0014).
 *
 * `recent(limit)` applied its LIMIT BEFORE any predicate, and the page then filtered the DOM
 * — so "Showing 3 of 200" described the last two hundred rows rather than the audit trail.
 * Here the predicate runs in SQL and the limit is what is left over, which is the only order
 * that makes the count on the page a true sentence.
 *
 * `q` matches the NAME of the record a row points at, not just the row's own columns: an
 * audit row stores an id, and nobody searches for an id.
 */
export interface AuditQuery {
  entity?: AuditEntity[];
  action?: AuditAction[];
  actor?: string[];
  /** Inclusive ISO date bounds, `YYYY-MM-DD`. */
  from?: string;
  to?: string;
  q?: string;
  limit?: number;
}

// `archivedAt` is deliberately not creatable and not patchable: nothing is born archived,
// and archiving is a verb with its own audit row rather than a field an edit form can set.
export type NewClient = Omit<Client, 'id' | 'archivedAt' | 'createdAt' | 'updatedAt'>;
export type NewCustomer = Omit<Customer, 'id' | 'archivedAt' | 'createdAt' | 'updatedAt'>;
export type NewTicket = Omit<
  Ticket,
  'id' | 'ticketId' | 'createdAt' | 'updatedAt'
>;

export interface ClientRepository {
  /** Live records only unless asked otherwise (0012); one query object since 0014. */
  list(query?: ClientQuery): Client[];
  /** By id, whatever its scope — an archived record stays addressable. */
  get(id: string): Client | null;
  create(input: NewClient): Client;
  update(id: string, patch: Partial<NewClient>): Client;
  /** `at` is an ISO timestamp to archive, or null to restore. */
  setArchived(id: string, at: string | null): Client;
  remove(id: string): void;
}

export interface CustomerRepository {
  list(query?: CustomerQuery): Customer[];
  get(id: string): Customer | null;
  /** The same predicate as `list({ q })`, capped — it backs the live type-ahead. */
  search(query: string, scope?: ListScope): Customer[];
  create(input: NewCustomer): Customer;
  update(id: string, patch: Partial<NewCustomer>): Customer;
  setArchived(id: string, at: string | null): Customer;
  remove(id: string): void;
}

export interface TicketRepository {
  /** Tickets carry no flag of their own; they are hidden by their customer's lineage. */
  list(query?: TicketQuery): Ticket[];
  get(id: string): Ticket | null;
  /**
   * The board's columns, and the counts on the status facet.
   *
   * It takes the SAME query object as `list` — it used to take none and call `this.list()`,
   * which was correct only while the default scope was `live`. The board and the facet
   * counts have to be answers to one question or they disagree.
   */
  byStatus(query?: TicketQuery): Record<string, Ticket[]>;
  /** ticketId is assigned by the repo (per-customer sequence). */
  create(input: NewTicket): Ticket;
  update(id: string, patch: Partial<NewTicket>): Ticket;
  remove(id: string): void;
}

export interface AuditRepository {
  append(entry: Omit<AuditEntry, 'id' | 'at'>): AuditEntry;
  forEntity(entity: string, entityId: string): AuditEntry[];
  recent(limit?: number): AuditEntry[];
  /** Filtered in SQL, limited afterwards. See `AuditQuery`. */
  query(q?: AuditQuery): AuditEntry[];
  /** How many rows the same predicate matches, ignoring `limit`. */
  count(q?: AuditQuery): number;
  /** Every actor that appears in the trail, so the facet can offer the real ones. */
  actors(): string[];
}

export type NewDocument = Omit<DocumentRef, 'id' | 'createdAt'>;

export interface DocumentRepository {
  list(query?: DocumentQuery): DocumentRef[];
  forEntity(entity: string, entityId: string): DocumentRef[];
  /** The same read for many records at once, keyed by entityId. Missing ids are absent. */
  forEntities(entity: string, entityIds: string[]): Map<string, DocumentRef[]>;
  get(id: string): DocumentRef | null;
  create(input: NewDocument): DocumentRef;
  remove(id: string): void;
}

/** Local key/value store. Also holds OAuth tokens — treat values as secret. */
export interface SettingsRepository {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  /**
   * Every key currently stored (0015).
   *
   * The bug report redacts the CONTENTS of this table out of the text it publishes, and
   * it does that as a sweep rather than from a list of known secret keys — a list would
   * have to be edited by whoever adds the next secret, and they will not, because their
   * plan is about something else. "Nothing in `settings` leaves this machine" only stays
   * true without maintenance if the table can be enumerated.
   */
  keys(): string[];
}

export interface Repositories {
  clients: ClientRepository;
  customers: CustomerRepository;
  tickets: TicketRepository;
  audit: AuditRepository;
  documents: DocumentRepository;
  settings: SettingsRepository;
}
