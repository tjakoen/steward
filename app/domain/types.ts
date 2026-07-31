// Domain types for STEWARD. Generic — no client-specific vocabulary, no PII.
//
// Hierarchy:  Client (branded org) → Customer (individual/household) → Ticket
// Every mutation appends an Audit row.

/** A person on a Customer record. Customers may be joint (2+ persons). */
export interface Person {
  given: string;
  family: string;
}

/** Branding stamped onto generated documents for a Client. Data, never hardcoded. */
export interface Branding {
  logoDataUrl: string | null; // inlined image (data: URL) so binaries need no asset paths
  primaryColor: string; // hex, e.g. "#1f4e5f"
  secondaryColor: string; // hex
  companyInfo: string; // address / registration / contact block
  pdfFooter: string;
}

/** A branded organization the platform serves. */
export interface Client {
  id: string;
  name: string;
  code: string; // short slug, unique
  branding: Branding;
  active: boolean;
  createdAt: string; // ISO 8601
  updatedAt: string;
}

/** An individual or household belonging to a Client. */
export interface Customer {
  id: string;
  clientId: string;
  code: string; // used in ticket-id, e.g. "DOEX"
  persons: Person[]; // 1 = individual, 2+ = joint household
  email: string;
  phone: string;
  externalId: string; // optional external system ref
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export const TICKET_STATUSES = [
  'Not Commenced',
  'In Progress',
  'Waiting',
  'Completed',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export interface ProgressEntry {
  date: string; // ISO 8601 (display formatting is a view concern)
  update: string;
}

export interface CommRef {
  date: string;
  subject: string;
}

/** A task ticket about a Customer. Renders to a branded document. */
export interface Ticket {
  id: string;
  customerId: string;
  ticketId: string; // human code, e.g. "TXDOEX0001"
  title: string;
  dateInitiated: string;
  status: TicketStatus;
  dateLastUpdated: string;
  waitingOn: string;
  waitingSince: string;
  summary: string;
  nextAction: string;
  progressLog: ProgressEntry[];
  commRefs: CommRef[];
  createdAt: string;
  updatedAt: string;
}

export type AuditEntity = 'client' | 'customer' | 'ticket';

/** How a document came to exist. */
export type DocumentSource =
  | 'generated' // produced by STEWARD (e.g. a ticket PDF)
  | 'upload' // a file the operator attached
  | 'link'; // a file that lives elsewhere; STEWARD only points at it

/** Where the bytes actually are. Swappable behind the DocumentStore port. */
export type DocumentStorage = 'local' | 'drive';

/**
 * A file belonging to a record. `entity` + `entityId` is what makes a document
 * more than a loose file: a generated PDF is *the document of ticket X*, and
 * carries that lineage everywhere it is shown.
 */
export interface DocumentRef {
  id: string;
  entity: AuditEntity;
  entityId: string;
  name: string;
  mimeType: string;
  size: number; // bytes; 0 for links (the bytes aren't ours)
  source: DocumentSource;
  storage: DocumentStorage;
  storageId: string; // path on disk, or the Drive file id
  webViewLink: string; // '' unless the file lives somewhere with a URL
  createdAt: string; // ISO 8601
  createdBy: string; // actor — same vocabulary as audit rows
}
export type AuditAction = 'create' | 'update' | 'archive' | 'delete';

/** Append-only history of every mutation. */
export interface AuditEntry {
  id: string;
  entity: AuditEntity;
  entityId: string;
  action: AuditAction;
  actor: string; // "human" | "ai" | a named operator
  at: string; // ISO 8601
  diff: string; // JSON string of the change
}
