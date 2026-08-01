import { test, expect } from 'bun:test';
import { isAbsolute, join } from 'node:path';
import { dataDir, documentsDir, envFile, loadEnvFile, PACKAGED, VERSION } from './paths.ts';
import { dbPath } from './repo/db.ts';

test('a checkout is never mistaken for a shipped binary', () => {
  // Both are --define'd only by scripts/build.ts. If either of these flips while running
  // from source, the app would start writing to a per-user application directory and the
  // repo's own data would look empty.
  expect(PACKAGED).toBe(false);
  expect(VERSION).toBe('dev');
});

test('every path is absolute', () => {
  // The whole point of 0009's path work: nothing may depend on the cwd, because a
  // double-clicked exe has whatever cwd Explorer felt like handing it.
  for (const p of [dataDir(), documentsDir(), envFile(), dbPath()]) {
    expect(isAbsolute(p)).toBe(true);
  }
});

test('STEWARD_DATA relocates the whole data directory', () => {
  const prev = process.env.STEWARD_DATA;
  process.env.STEWARD_DATA = '/tmp/steward-test-data';
  try {
    expect(dataDir()).toBe('/tmp/steward-test-data');
    expect(documentsDir()).toBe(join('/tmp/steward-test-data', 'documents'));
  } finally {
    if (prev === undefined) delete process.env.STEWARD_DATA;
    else process.env.STEWARD_DATA = prev;
  }
});

test('STEWARD_DB still wins over the data directory', () => {
  // The tests rely on this, and so does anyone pointing a run at a copy of the database.
  const prev = process.env.STEWARD_DB;
  process.env.STEWARD_DB = ':memory:';
  try {
    expect(dbPath()).toBe(':memory:');
  } finally {
    if (prev === undefined) delete process.env.STEWARD_DB;
    else process.env.STEWARD_DB = prev;
  }
});

test('loadEnvFile reads the small format and nothing more', () => {
  const env: Record<string, string | undefined> = {};
  const applied = loadEnvFile(
    [
      '# a comment',
      '',
      'OLLAMA_URL=http://localhost:11434',
      'QUOTED="with spaces"',
      "SINGLE='also quoted'",
      'PADDED  =  trimmed  ',
      'EQUALS_IN_VALUE=a=b=c',
      'no_equals_sign',
      '=novalue',
    ].join('\n'),
    env,
  );

  expect(env.OLLAMA_URL).toBe('http://localhost:11434');
  expect(env.QUOTED).toBe('with spaces');
  expect(env.SINGLE).toBe('also quoted');
  expect(env.PADDED).toBe('trimmed');
  // Only the FIRST `=` separates; a token is a perfectly ordinary thing to contain one.
  expect(env.EQUALS_IN_VALUE).toBe('a=b=c');
  expect(applied).toEqual(['OLLAMA_URL', 'QUOTED', 'SINGLE', 'PADDED', 'EQUALS_IN_VALUE']);
});

test('a real environment variable outranks the file', () => {
  // Someone who exported a variable meant it. A file that silently overrode it would make
  // `OLLAMA_URL=… steward` a no-op, which is the kind of thing that costs an afternoon.
  const env: Record<string, string | undefined> = { OLLAMA_URL: 'http://set-by-hand' };
  const applied = loadEnvFile('OLLAMA_URL=http://from-file\nNEW=yes', env);
  expect(env.OLLAMA_URL).toBe('http://set-by-hand');
  expect(applied).toEqual(['NEW']);
});
