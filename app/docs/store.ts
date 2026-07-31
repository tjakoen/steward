// Where document BYTES live. The `documents` table is the index over files;
// this port is the files themselves.
//
// Two implementations, chosen at the composition root:
//   - local disk (default) — works offline, with no Google account at all
//   - Google Drive         — once the operator connects theirs in Settings
//
// A desktop app has to work before (and without) an OAuth round-trip, so the
// local store is not a stub: it is the honest default.

import { join, extname, basename } from 'node:path';
import { rm } from 'node:fs/promises';

export interface StoredFile {
  /** Opaque handle the store can read back later (a path, or a Drive id). */
  storageId: string;
  size: number;
  /** A URL a human can open, when the backing store has one. '' otherwise. */
  webViewLink: string;
}

export interface DocumentStore {
  readonly kind: 'local' | 'drive';
  put(name: string, bytes: Uint8Array, mimeType: string): Promise<StoredFile>;
  get(storageId: string): Promise<Uint8Array | null>;
  remove(storageId: string): Promise<void>;
}

/** Guess a content type from the file name; used when the client sends none. */
export function mimeFor(name: string): string {
  const ext = extname(name).toLowerCase();
  const map: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
    '.json': 'application/json',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return map[ext] ?? 'application/octet-stream';
}

/**
 * Strip a caller-supplied filename down to something safe to place on disk.
 * Names arrive from uploads, so they are untrusted: path separators and
 * traversal segments must never survive into a storage id.
 */
export function safeName(name: string): string {
  const base = basename(name).replace(/[/\\]/g, '');
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned.slice(0, 120) || 'file';
}

/** Files on local disk, one flat directory, ids prefixed to avoid collisions. */
export class LocalDocumentStore implements DocumentStore {
  readonly kind = 'local' as const;

  constructor(private dir: string) {}

  /**
   * Resolve a storage id to a path inside `dir` — never outside it. Ids are
   * ours, but they round-trip through the database and the URL, so treat them
   * as untrusted: `basename` drops any directory part, traversal included.
   */
  private pathFor(storageId: string): string {
    const clean = basename(storageId).replace(/^\.+/, '');
    if (!clean) throw new Error('invalid storage id');
    return join(this.dir, clean);
  }

  async put(name: string, bytes: Uint8Array, _mimeType: string): Promise<StoredFile> {
    const storageId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${safeName(name)}`;
    await Bun.write(this.pathFor(storageId), bytes);
    return { storageId, size: bytes.byteLength, webViewLink: '' };
  }

  async get(storageId: string): Promise<Uint8Array | null> {
    const file = Bun.file(this.pathFor(storageId));
    if (!(await file.exists())) return null;
    return new Uint8Array(await file.arrayBuffer());
  }

  async remove(storageId: string): Promise<void> {
    // Removal is idempotent — a missing file is already the desired state.
    await rm(this.pathFor(storageId), { force: true });
  }
}
