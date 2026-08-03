// SQLite is the source of truth. One open DB per process.
// Path resolves from STEWARD_DB env, else <data dir>/steward.db (demo.db in DEMO mode).
// The data directory is the repo's own `data/` from a checkout and a per-user application
// directory from a shipped binary — see app/paths.ts for why those must differ.

import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from '../paths.ts';

export function dbPath(): string {
  if (process.env.STEWARD_DB) return process.env.STEWARD_DB;
  return join(dataDir(), process.env.DEMO === '1' ? 'demo.db' : 'steward.db');
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

/**
 * Steps a database created BEFORE a schema change has to take to catch up.
 *
 * Until 0012 the whole schema was one `CREATE TABLE IF NOT EXISTS` block, which is
 * idempotent and was enough for eleven plans because every table was born complete. It
 * cannot add a column to a database that already holds rows, and by then the operator's
 * did — so this is the ladder, kept as small as the job needs.
 *
 * The index is the version: a database at `user_version` N has taken steps 0..N-1.
 * A step runs in a transaction, so a failure half way leaves the version behind rather
 * than a schema nobody can describe.
 *
 * `ADD COLUMN` cannot be `NOT NULL` without a default, which is part of why `archivedAt`
 * is a nullable timestamp rather than an `archived INTEGER NOT NULL DEFAULT 0`. Null means
 * live; a timestamp means archived and says when on its face.
 */
const STEPS: ((d: Database) => void)[] = [
  // 1 — 0012: archive instead of delete.
  (d) => {
    d.exec('ALTER TABLE clients ADD COLUMN archivedAt TEXT');
    d.exec('ALTER TABLE customers ADD COLUMN archivedAt TEXT');
  },
];

function migrate(d: Database): void {
  // Asked BEFORE the create block, because afterwards every database looks alike. A fresh
  // one is born with every column the steps would add, so running them would fail on
  // `duplicate column name` — it is stamped at the latest version instead.
  const fresh = !d
    .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type='table' AND name='clients'`)
    .get();

  d.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      branding TEXT NOT NULL,          -- JSON Branding
      -- Vestigial (0012). Never read, never written, kept only because dropping a column
      -- is a destructive migration in exchange for tidiness. archivedAt is the flag.
      active INTEGER NOT NULL DEFAULT 1,
      archivedAt TEXT,                 -- null = live; ISO 8601 = archived, and when
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
      archivedAt TEXT,
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

    -- Local key/value settings. Also holds OAuth tokens, which are
    -- CREDENTIALS: never audited, never rendered, never leave this machine.
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  if (fresh) {
    d.exec(`PRAGMA user_version = ${STEPS.length}`);
    return;
  }

  // `PRAGMA user_version = ?` does not take a bound parameter, so the number is
  // interpolated. It is `STEPS.length` — ours, not anyone's input.
  const at = d.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;
  for (let i = at; i < STEPS.length; i++) d.transaction(() => STEPS[i](d))();
  if (at < STEPS.length) d.exec(`PRAGMA user_version = ${STEPS.length}`);
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
