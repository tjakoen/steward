// Documents: what a LINK is, and — the part that matters — what unlinking one
// must never do. A linked file is the operator's own, pre-existing file; the
// Picker only granted us access to it. Forgetting the reference must not reach
// into their Drive and delete it.

import { test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { setDb } from '../repo/db.ts';
import { sqliteRepositories } from '../repo/sqlite.ts';
import { makeServices } from './index.ts';
import type { DocumentStore, StoredFile } from '../docs/store.ts';

/** A store that records what it was asked to do. */
function spyStore(kind: 'local' | 'drive' = 'drive') {
  const removed: string[] = [];
  const bytes = new Map<string, Uint8Array>();
  const store: DocumentStore = {
    kind,
    async put(name, data): Promise<StoredFile> {
      const id = `${kind}:${name}`;
      bytes.set(id, data);
      return { storageId: id, size: data.byteLength, webViewLink: `https://drive.example/${name}` };
    },
    async get(id) { return bytes.get(id) ?? null; },
    async remove(id) { removed.push(id); bytes.delete(id); },
  };
  return { store, removed };
}

function fresh(kind: 'local' | 'drive' = 'drive') {
  setDb(new Database(':memory:'));
  const spy = spyStore(kind);
  const repos = sqliteRepositories();
  const services = makeServices(repos, {
    active: () => spy.store,
    forKind: () => spy.store,
  });
  const client = services.createClient(
    { name: 'Acme', code: 'acme', active: true,
      branding: { logoDataUrl: null, primaryColor: '#000', secondaryColor: '#111', companyInfo: '', pdfFooter: '' } },
    'human',
  );
  return { services, spy, client };
}

beforeEach(() => { setDb(new Database(':memory:')); });

test('a linked Drive file is recorded as a reference, not a copy', () => {
  const { services, client } = fresh();
  const doc = services.linkDocument(
    { entity: 'client', entityId: client.id },
    { name: 'Contract.pdf', url: 'https://drive.google.com/file/d/abc/view', mimeType: 'application/pdf', size: 2048 },
    'human',
  );

  expect(doc.source).toBe('link');
  expect(doc.storage).toBe('drive');
  expect(doc.webViewLink).toBe('https://drive.google.com/file/d/abc/view');
  expect(doc.size).toBe(2048);
  // Empty ON PURPOSE: this is what keeps removal from deleting the real file.
  expect(doc.storageId).toBe('');
});

test('a link with no size (a Google Doc) still records cleanly', () => {
  const { services, client } = fresh();
  const doc = services.linkDocument(
    { entity: 'client', entityId: client.id },
    { name: 'Notes', url: 'https://docs.google.com/document/d/xyz/edit' },
    'human',
  );
  expect(doc.size).toBe(0);
  expect(doc.mimeType).toBe('');
});

test('linking audits against the record it belongs to', () => {
  const { services, client } = fresh();
  services.linkDocument(
    { entity: 'client', entityId: client.id },
    { name: 'Contract.pdf', url: 'https://drive.google.com/file/d/abc/view' },
    'human',
  );
  const diffs = services.repos.audit.forEntity('client', client.id).map((e) => e.diff);
  expect(diffs.some((d) => d.includes('Contract.pdf'))).toBe(true);
});

test('a link has no bytes to read', async () => {
  const { services, client } = fresh();
  const doc = services.linkDocument(
    { entity: 'client', entityId: client.id },
    { name: 'Contract.pdf', url: 'https://drive.google.com/file/d/abc/view' },
    'human',
  );
  expect(await services.readDocument(doc)).toBeNull();
});

test('unlinking forgets the reference and leaves the Drive file alone', async () => {
  const { services, spy, client } = fresh();
  const doc = services.linkDocument(
    { entity: 'client', entityId: client.id },
    { name: 'Contract.pdf', url: 'https://drive.google.com/file/d/abc/view' },
    'human',
  );

  await services.removeDocument(doc.id, 'human');

  expect(services.getDocument(doc.id)).toBeNull();
  expect(spy.removed).toEqual([]); // nothing was deleted from Drive
});

test('removing an UPLOADED document does delete it from the store', async () => {
  const { services, spy, client } = fresh();
  const doc = await services.attachDocument(
    { entity: 'client', entityId: client.id },
    { name: 'scan.png', mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]) },
    'upload', 'human',
  );
  expect(doc.storageId).not.toBe('');

  await services.removeDocument(doc.id, 'human');

  expect(spy.removed).toEqual([doc.storageId]);
  expect(services.getDocument(doc.id)).toBeNull();
});
