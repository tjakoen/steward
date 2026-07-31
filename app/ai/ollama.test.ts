import { test, expect } from 'bun:test';
import { streamOllama } from './ollama.ts';

// Build a fake fetch whose response body streams the given NDJSON lines (optionally split
// mid-line across chunks, to exercise the buffer stitching).
function fakeFetch(lines: string[], chunkAt?: number) {
  const payload = lines.join('\n') + '\n';
  const bytes = new TextEncoder().encode(payload);
  const parts = chunkAt ? [bytes.slice(0, chunkAt), bytes.slice(chunkAt)] : [bytes];
  const body = new ReadableStream<Uint8Array>({
    start(c) { for (const p of parts) c.enqueue(p); c.close(); },
  });
  return (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
}

const line = (content: string, done = false) => JSON.stringify({ message: { content }, done });

test('yields content tokens in order and concatenates to the full reply', async () => {
  const f = fakeFetch([line('Hel'), line('lo'), line(' world'), line('', true)]);
  let full = '';
  for await (const tok of streamOllama([{ role: 'user', content: 'hi' }], { fetchImpl: f })) full += tok;
  expect(full).toBe('Hello world');
});

test('stitches a JSON object split across two network chunks', async () => {
  const lines = [line('one'), line('two')];
  const splitInside = Math.floor((lines.join('\n').length) / 2);
  const f = fakeFetch(lines, splitInside);
  let full = '';
  for await (const tok of streamOllama([{ role: 'user', content: 'x' }], { fetchImpl: f })) full += tok;
  expect(full).toBe('onetwo');
});

test('skips malformed lines instead of throwing', async () => {
  const f = fakeFetch(['not json', line('ok')]);
  let full = '';
  for await (const tok of streamOllama([{ role: 'user', content: 'x' }], { fetchImpl: f })) full += tok;
  expect(full).toBe('ok');
});

test('throws an honest error on a non-OK response', async () => {
  const f = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
  const run = async () => { for await (const _ of streamOllama([{ role: 'user', content: 'x' }], { fetchImpl: f })) { /* drain */ } };
  await expect(run()).rejects.toThrow(/Ollama 500/);
});
