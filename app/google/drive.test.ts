import { test, expect } from 'bun:test';
import { GoogleDriveStore } from './drive.ts';
import type { GoogleAuth } from './oauth.ts';

/** A GoogleAuth stand-in: only accessToken() matters to the store. */
const authWith = (token: string | null): GoogleAuth => ({
  accessToken: async () => token,
} as unknown as GoogleAuth);

interface Call { url: string; method: string; headers: Record<string, string>; body?: unknown }

/** Multipart bodies are bytes; read them back as text to assert on. */
const bodyText = (body: unknown): string =>
  body instanceof Uint8Array ? new TextDecoder().decode(body) : String(body);

const isFolderSearch = (c: Call) => c.method === 'GET' && c.url.includes('/drive/v3/files?q=');
const isFolderCreate = (c: Call) => c.method === 'POST' && c.url.endsWith('/drive/v3/files');

/** Fake Drive: records calls, replies from a queue of responses. */
function fakeDrive(responses: unknown[]) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url, method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>, body: init.body,
    });
    const next = responses.shift();
    if (next instanceof Response) return next;
    return new Response(JSON.stringify(next ?? {}), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('put creates the STEWARD folder once, then uploads into it', async () => {
  const { impl, calls } = fakeDrive([
    { files: [] }, // folder search: none yet
    { id: 'folder_1' }, // folder created
    { id: 'file_1', size: '12', webViewLink: 'https://drive.google.com/file_1' },
    { id: 'file_2', size: '9', webViewLink: 'https://drive.google.com/file_2' },
  ]);
  const store = new GoogleDriveStore(authWith('tok'), 'STEWARD', impl);

  const first = await store.put('a.txt', new Uint8Array([1, 2, 3]), 'text/plain');
  expect(first).toEqual({ storageId: 'file_1', size: 12, webViewLink: 'https://drive.google.com/file_1' });

  const second = await store.put('b.txt', new Uint8Array([4]), 'text/plain');
  expect(second.storageId).toBe('file_2');

  // The folder is resolved once and cached — the second upload does not re-search.
  expect(calls.filter(isFolderSearch).length).toBe(1);
  expect(calls.filter(isFolderCreate).length).toBe(1);
  expect(calls.every((c) => c.headers.Authorization === 'Bearer tok')).toBe(true);
});

test('put reuses an existing STEWARD folder instead of making another', async () => {
  const { impl, calls } = fakeDrive([
    { files: [{ id: 'existing_folder' }] },
    { id: 'file_1', size: '3', webViewLink: '' },
  ]);
  const store = new GoogleDriveStore(authWith('tok'), 'STEWARD', impl);
  await store.put('a.txt', new Uint8Array([1, 2, 3]), 'text/plain');

  expect(calls.some(isFolderCreate)).toBe(false);
  // The upload names the existing folder as its parent.
  expect(bodyText(calls[1].body)).toContain('existing_folder');
});

test('an upload rejection surfaces the Drive error message', async () => {
  const { impl } = fakeDrive([
    { files: [{ id: 'f' }] },
    new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), { status: 403 }),
  ]);
  const store = new GoogleDriveStore(authWith('tok'), 'STEWARD', impl);
  expect(store.put('a.txt', new Uint8Array([1]), 'text/plain')).rejects.toThrow(/quota exceeded/);
});

test('get returns bytes, and null for a file that is gone', async () => {
  const { impl } = fakeDrive([
    new Response(new Uint8Array([7, 8, 9]), { status: 200 }),
    new Response('', { status: 404 }),
  ]);
  const store = new GoogleDriveStore(authWith('tok'), 'STEWARD', impl);
  expect(await store.get('file_1')).toEqual(new Uint8Array([7, 8, 9]));
  expect(await store.get('missing')).toBeNull();
});

test('remove is idempotent: an already-deleted file is not an error', async () => {
  const { impl, calls } = fakeDrive([
    new Response('', { status: 204 }),
    new Response('', { status: 404 }),
  ]);
  const store = new GoogleDriveStore(authWith('tok'), 'STEWARD', impl);
  await store.remove('file_1');
  await store.remove('already_gone');
  expect(calls.every((c) => c.method === 'DELETE')).toBe(true);
});

test('a real failure on delete is reported', async () => {
  const { impl } = fakeDrive([new Response('', { status: 500 })]);
  const store = new GoogleDriveStore(authWith('tok'), 'STEWARD', impl);
  expect(store.remove('file_1')).rejects.toThrow(/500/);
});

test('every operation refuses to run when Drive is not connected', async () => {
  const { impl, calls } = fakeDrive([]);
  const store = new GoogleDriveStore(authWith(null), 'STEWARD', impl);
  expect(store.put('a.txt', new Uint8Array([1]), 'text/plain')).rejects.toThrow(/not connected/);
  expect(store.get('x')).rejects.toThrow(/not connected/);
  expect(store.remove('x')).rejects.toThrow(/not connected/);
  expect(calls.length).toBe(0); // and never reaches the network
});
