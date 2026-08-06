// Repository ports. Services depend on these interfaces, not on SQLite.
// Swap the impl at the composition root (in-memory for tests, sqlite in prod).

import type {
  AuditEntry,
  Client,
  Customer,
  DocumentRef,
  ListScope,
  Ticket,
} from '../domain/types.ts';

// `archivedAt` is deliberately not creatable and not patchable: nothing is born archived,
// and archiving is a verb with its own audit row rather than a field an edit form can set.
export type NewClient = Omit<Client, 'id' | 'archivedAt' | 'createdAt' | 'updatedAt'>;
export type NewCustomer = Omit<Customer, 'id' | 'archivedAt' | 'createdAt' | 'updatedAt'>;
export type NewTicket = Omit<
  Ticket,
  'id' | 'ticketId' | 'createdAt' | 'updatedAt'
>;

export interface ClientRepository {
  /** Live records only unless asked otherwise (0012). */
  list(scope?: ListScope): Client[];
  /** By id, whatever its scope — an archived record stays addressable. */
  get(id: string): Client | null;
  create(input: NewClient): Client;
  update(id: string, patch: Partial<NewClient>): Client;
  /** `at` is an ISO timestamp to archive, or null to restore. */
  setArchived(id: string, at: string | null): Client;
  remove(id: string): void;
}

export interface CustomerRepository {
  list(clientId?: string, scope?: ListScope): Customer[];
  get(id: string): Customer | null;
  search(query: string, scope?: ListScope): Customer[];
  create(input: NewCustomer): Customer;
  update(id: string, patch: Partial<NewCustomer>): Customer;
  setArchived(id: string, at: string | null): Customer;
  remove(id: string): void;
}

export interface TicketRepository {
  /** Tickets carry no flag of their own; they are hidden by their customer's lineage. */
  list(customerId?: string, scope?: ListScope): Ticket[];
  get(id: string): Ticket | null;
  byStatus(): Record<string, Ticket[]>;
  /** ticketId is assigned by the repo (per-customer sequence). */
  create(input: NewTicket): Ticket;
  update(id: string, patch: Partial<NewTicket>): Ticket;
  remove(id: string): void;
}

export interface AuditRepository {
  append(entry: Omit<AuditEntry, 'id' | 'at'>): AuditEntry;
  forEntity(entity: string, entityId: string): AuditEntry[];
  recent(limit?: number): AuditEntry[];
}

export type NewDocument = Omit<DocumentRef, 'id' | 'createdAt'>;

export interface DocumentRepository {
  list(): DocumentRef[];
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
