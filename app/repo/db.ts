// SQLite is the source of truth. One open DB per process.
// Path resolves from STEWARD_DB env, else data/steward.db (data/demo.db in DEMO mode).

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function dbPath(): string {
  if (process.env.STEWARD_DB) return process.env.STEWARD_DB;
  return process.env.DEMO === '1' ? 'data/demo.db' : 'data/steward.db';
}

let instance: Database | null = null;

export function db(): Database {
  if (instance) return instance;
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path, { create: true });
  database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(database);
  instance = database;
  return instance;
}

/** For tests / demo reset: point at a fresh handle (e.g. in-memory ":memory:"). */
export function setDb(database: Database): void {
  instance = database;
  database.exec('PRAGMA foreign_keys = ON;');
  migrate(database);
}

function migrate(d: Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      branding TEXT NOT NULL,          -- JSON Branding
      active INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      clientId TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      persons TEXT NOT NULL,           -- JSON Person[]
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      externalId TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_customers_client ON customers(clientId);

    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      customerId TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      ticketId TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL DEFAULT '',
      dateInitiated TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Not Commenced',
      dateLastUpdated TEXT NOT NULL DEFAULT '',
      waitingOn TEXT NOT NULL DEFAULT '',
      waitingSince TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      nextAction TEXT NOT NULL DEFAULT '',
      progressLog TEXT NOT NULL DEFAULT '[]',   -- JSON ProgressEntry[]
      commRefs TEXT NOT NULL DEFAULT '[]',       -- JSON CommRef[]
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tickets_customer ON tickets(customerId);
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);

    -- per-customer monotonic sequence for ticket ids (survives deletes)
    CREATE TABLE IF NOT EXISTS ticket_seq (
      customerId TEXT PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS audit (
      id TEXT PRIMARY KEY,
      entity TEXT NOT NULL,
      entityId TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      at TEXT NOT NULL,
      diff TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit(entity, entityId);

    -- Files belonging to a record. The bytes live behind the DocumentStore
    -- port (local disk or Drive); this table is the index over them.
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      entity TEXT NOT NULL,
      entityId TEXT NOT NULL,
      name TEXT NOT NULL,
      mimeType TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL,            -- generated | upload | link
      storage TEXT NOT NULL,           -- local | drive
      storageId TEXT NOT NULL,
      webViewLink TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL,
      createdBy TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_documents_entity ON documents(entity, entityId);
  `);
}

/** Next ticket sequence number for a customer (atomic). */
export function nextTicketSeq(d: Database, customerId: string): number {
  d.run(
    `INSERT INTO ticket_seq (customerId, seq) VALUES (?, 1)
     ON CONFLICT(customerId) DO UPDATE SET seq = seq + 1`,
    [customerId],
  );
  const row = d
    .query<{ seq: number }, [string]>('SELECT seq FROM ticket_seq WHERE customerId = ?')
    .get(customerId);
  return row?.seq ?? 1;
}
