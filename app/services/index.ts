// Services own the verbs. Every mutation writes an audit row in the same call.
// Routes / the /intent door call these; they never touch repositories directly.

import type { Repositories, NewClient, NewCustomer, NewTicket } from '../repo/ports.ts';
import type {
  AuditEntity, Client, Customer, DocumentRef, Ticket, TicketStatus, ProgressEntry,
} from '../domain/types.ts';
import type { DocumentStore } from '../docs/store.ts';

export interface Actor {
  /** "human" | "ai" | a named operator — recorded on audit rows. */
  actor: string;
}

export function makeServices(repos: Repositories, store?: DocumentStore) {
  const audit = (
    entity: 'client' | 'customer' | 'ticket',
    entityId: string,
    action: 'create' | 'update' | 'archive' | 'delete',
    actor: string,
    diff: unknown,
  ) => repos.audit.append({ entity, entityId, action, actor, diff: JSON.stringify(diff) });

  const requireStore = (): DocumentStore => {
    if (!store) throw new Error('no document store configured');
    return store;
  };

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

    // --- documents ---
    // A document belongs to a record, so attaching or removing one is a change
    // TO THAT RECORD: it audits against the owning entity, and shows up in that
    // record's History next to every other change.
    documentsFor(entity: string, entityId: string): DocumentRef[] {
      return repos.documents.forEntity(entity, entityId);
    },
    listDocuments(): DocumentRef[] {
      return repos.documents.list();
    },
    getDocument(id: string): DocumentRef | null {
      return repos.documents.get(id);
    },

    /** Store bytes and index them against a record. */
    async attachDocument(
      target: { entity: AuditEntity; entityId: string },
      file: { name: string; mimeType: string; bytes: Uint8Array },
      source: 'upload' | 'generated',
      by: string,
    ): Promise<DocumentRef> {
      const s = requireStore();
      const stored = await s.put(file.name, file.bytes, file.mimeType);
      const doc = repos.documents.create({
        entity: target.entity, entityId: target.entityId,
        name: file.name, mimeType: file.mimeType, size: stored.size,
        source, storage: s.kind, storageId: stored.storageId,
        webViewLink: stored.webViewLink, createdBy: by,
      });
      audit(target.entity, target.entityId, 'update', by, { attached: doc.name, source });
      return doc;
    },

    /** Point at a file that lives elsewhere; STEWARD stores no bytes. */
    linkDocument(
      target: { entity: AuditEntity; entityId: string },
      link: { name: string; url: string; mimeType?: string },
      by: string,
    ): DocumentRef {
      const doc = repos.documents.create({
        entity: target.entity, entityId: target.entityId,
        name: link.name, mimeType: link.mimeType ?? '', size: 0,
        source: 'link', storage: 'drive', storageId: '',
        webViewLink: link.url, createdBy: by,
      });
      audit(target.entity, target.entityId, 'update', by, { linked: doc.name });
      return doc;
    },

    /** Read a document's bytes back. Links have none — they live elsewhere. */
    async readDocument(doc: DocumentRef): Promise<Uint8Array | null> {
      if (doc.source === 'link' || !doc.storageId) return null;
      return requireStore().get(doc.storageId);
    },

    async removeDocument(id: string, by: string): Promise<void> {
      const doc = repos.documents.get(id);
      if (!doc) return;
      if (doc.source !== 'link' && doc.storageId && store) await store.remove(doc.storageId);
      repos.documents.remove(id);
      audit(doc.entity, doc.entityId, 'update', by, { removedDocument: doc.name });
    },
  };
}

export type Services = ReturnType<typeof makeServices>;
