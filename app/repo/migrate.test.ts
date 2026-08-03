// 0012 laid the first migration step, so this is the first test of the ladder itself.
//
// The dangerous case is not a fresh database — it is the operator's, which already holds
// rows and has never seen an ALTER. Both paths are exercised here against a real SQLite
// file, because `CREATE TABLE IF NOT EXISTS` hides the difference perfectly in memory.

import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { setDb } from './db.ts';
import { sqliteRepositories } from './sqlite.ts';

/** The clients/customers tables exactly as they were BEFORE 0012 — no archivedAt. */
const PRE_0012 = `
  CREATE TABLE clients (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE,
    branding TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  );
  CREATE TABLE customers (
    id TEXT PRIMARY KEY,
    clientId TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    code TEXT NOT NULL, persons TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
    externalId TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  );
`;

const columns = (d: Database, table: string): string[] =>
  d.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((r) => r.name);

const version = (d: Database): number =>
  d.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0;

test('a fresh database is born complete and reports itself up to date', () => {
  const d = new Database(':memory:');
  setDb(d);
  expect(columns(d, 'clients')).toContain('archivedAt');
  expect(columns(d, 'customers')).toContain('archivedAt');
  expect(version(d)).toBeGreaterThan(0);
});

test('an existing database with rows gains the column and keeps every row', () => {
  const d = new Database(':memory:');
  d.exec(PRE_0012);
  d.run(`INSERT INTO clients (id,name,code,branding,active,createdAt,updatedAt)
         VALUES ('cli_1','Acme','acme','{}',1,'2026-01-01','2026-01-01')`);
  d.run(`INSERT INTO customers (id,clientId,code,persons,createdAt,updatedAt)
         VALUES ('cus_1','cli_1','DOEX','[]','2026-01-01','2026-01-01')`);
  expect(columns(d, 'clients')).not.toContain('archivedAt');
  expect(version(d)).toBe(0);

  setDb(d); // <- the migration

  expect(columns(d, 'clients')).toContain('archivedAt');
  expect(columns(d, 'customers')).toContain('archivedAt');
  expect(d.query('SELECT id FROM clients').all()).toHaveLength(1);
  expect(d.query('SELECT id FROM customers').all()).toHaveLength(1);
  // Existing rows are LIVE, not archived — the default has to be null, not the epoch.
  const repos = sqliteRepositories();
  expect(repos.clients.list()).toHaveLength(1);
  expect(repos.clients.get('cli_1')?.archivedAt).toBeNull();
});

test('running the ladder twice is a no-op rather than a duplicate-column error', () => {
  const d = new Database(':memory:');
  d.exec(PRE_0012);
  setDb(d);
  const after = version(d);
  expect(() => setDb(d)).not.toThrow();
  expect(version(d)).toBe(after);
});

test('the vestigial active column survives, unread', () => {
  // Kept deliberately: dropping it is a destructive migration bought for tidiness, and
  // 0011 will otherwise find it in the sheet and wonder what it means.
  const d = new Database(':memory:');
  setDb(d);
  expect(columns(d, 'clients')).toContain('active');
  const repos = sqliteRepositories();
  const c = repos.clients.create({
    name: 'Acme', code: 'acme',
    branding: { logoDataUrl: null, primaryColor: '', secondaryColor: '', companyInfo: '', pdfFooter: '' },
  });
  // The insert names no `active`, so the column default is what fills it in.
  expect(d.query<{ active: number }, [string]>('SELECT active FROM clients WHERE id = ?').get(c.id)?.active).toBe(1);
});
