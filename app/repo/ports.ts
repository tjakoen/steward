// Repository ports. Services depend on these interfaces, not on SQLite.
// Swap the impl at the composition root (in-memory for tests, sqlite in prod).

import type {
  AuditEntry,
  Client,
  Customer,
  Ticket,
} from '../domain/types.ts';

export type NewClient = Omit<Client, 'id' | 'createdAt' | 'updatedAt'>;
export type NewCustomer = Omit<Customer, 'id' | 'createdAt' | 'updatedAt'>;
export type NewTicket = Omit<
  Ticket,
  'id' | 'ticketId' | 'createdAt' | 'updatedAt'
>;

export interface ClientRepository {
  list(): Client[];
  get(id: string): Client | null;
  create(input: NewClient): Client;
  update(id: string, patch: Partial<NewClient>): Client;
  remove(id: string): void;
}

export interface CustomerRepository {
  list(clientId?: string): Customer[];
  get(id: string): Customer | null;
  search(query: string): Customer[];
  create(input: NewCustomer): Customer;
  update(id: string, patch: Partial<NewCustomer>): Customer;
  remove(id: string): void;
}

export interface TicketRepository {
  list(customerId?: string): Ticket[];
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

export interface Repositories {
  clients: ClientRepository;
  customers: CustomerRepository;
  tickets: TicketRepository;
  audit: AuditRepository;
}
