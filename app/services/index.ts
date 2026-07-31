// Services own the verbs. Every mutation writes an audit row in the same call.
// Routes / the /intent door call these; they never touch repositories directly.

import type { Repositories, NewClient, NewCustomer, NewTicket } from '../repo/ports.ts';
import type {
  Client, Customer, Ticket, TicketStatus, ProgressEntry,
} from '../domain/types.ts';

export interface Actor {
  /** "human" | "ai" | a named operator — recorded on audit rows. */
  actor: string;
}

export function makeServices(repos: Repositories) {
  const audit = (
    entity: 'client' | 'customer' | 'ticket',
    entityId: string,
    action: 'create' | 'update' | 'archive' | 'delete',
    actor: string,
    diff: unknown,
  ) => repos.audit.append({ entity, entityId, action, actor, diff: JSON.stringify(diff) });

  return {
    repos,

    // --- clients ---
    createClient(input: NewClient, by: string): Client {
      const c = repos.clients.create(input);
      audit('client', c.id, 'create', by, input);
      return c;
    },
    updateClient(id: string, patch: Partial<NewClient>, by: string): Client {
      const c = repos.clients.update(id, patch);
      audit('client', id, 'update', by, patch);
      return c;
    },

    // --- customers ---
    createCustomer(input: NewCustomer, by: string): Customer {
      const c = repos.customers.create(input);
      audit('customer', c.id, 'create', by, input);
      return c;
    },
    updateCustomer(id: string, patch: Partial<NewCustomer>, by: string): Customer {
      const c = repos.customers.update(id, patch);
      audit('customer', id, 'update', by, patch);
      return c;
    },
    searchCustomers(query: string): Customer[] {
      return repos.customers.search(query);
    },

    // --- tickets ---
    createTicket(input: NewTicket, by: string): Ticket {
      const t = repos.tickets.create(input);
      audit('ticket', t.id, 'create', by, { ticketId: t.ticketId, ...input });
      return t;
    },
    updateTicket(id: string, patch: Partial<NewTicket>, by: string): Ticket {
      const t = repos.tickets.update(id, patch);
      audit('ticket', id, 'update', by, patch);
      return t;
    },
    setTicketStatus(id: string, status: TicketStatus, by: string): Ticket {
      const t = repos.tickets.update(id, { status, dateLastUpdated: new Date().toISOString() });
      audit('ticket', id, 'update', by, { status });
      return t;
    },
    addProgress(id: string, entry: ProgressEntry, by: string): Ticket {
      const cur = repos.tickets.get(id);
      if (!cur) throw new Error(`ticket not found: ${id}`);
      const t = repos.tickets.update(id, {
        progressLog: [...cur.progressLog, entry],
        dateLastUpdated: new Date().toISOString(),
      });
      audit('ticket', id, 'update', by, { addProgress: entry });
      return t;
    },
  };
}

export type Services = ReturnType<typeof makeServices>;
