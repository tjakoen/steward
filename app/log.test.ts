import { test, expect, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFileLog, logFile } from './log.ts';

// The console mirror is a global mutation, so every test here puts it back.
const original = { log: console.log, warn: console.warn, error: console.error };
const restore = () => { console.log = original.log; console.warn = original.warn; console.error = original.error; };

const inTempData = <T>(fn: (dir: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), 'steward-log-'));
  const before = process.env.STEWARD_DATA;
  process.env.STEWARD_DATA = dir;
  try { return fn(dir); } finally {
    if (before === undefined) delete process.env.STEWARD_DATA; else process.env.STEWARD_DATA = before;
  }
};

afterEach(restore);

test('a checkout writes no log file — the terminal is right there', () => {
  inTempData((dir) => {
    expect(installFileLog()).toBeNull();
    expect(existsSync(join(dir, 'steward.log'))).toBe(false);
  });
});

test('console output is mirrored to the file, and still reaches the console', () => {
  inTempData((dir) => {
    const seen: unknown[][] = [];
    console.log = (...a: unknown[]) => { seen.push(a); };

    const file = installFileLog(true);
    expect(file).toBe(join(dir, 'steward.log'));
    console.log('STEWARD 0.2.0 → http://localhost:3000');
    console.error('[server]', new Error('boom').message);
    restore();

    const text = readFileSync(file!, 'utf8');
    expect(text).toContain('STEWARD 0.2.0');
    expect(text).toContain('boom');
    // Timestamped: a log without times cannot answer "did this run start at all?"
    expect(text.split('\n')[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // And the original console still saw it — the file is a mirror, not a diversion.
    expect(seen.length).toBe(1);
  });
});

test('a log past a megabyte is rolled over, not grown forever', () => {
  inTempData((dir) => {
    const file = join(dir, 'steward.log');
    writeFileSync(file, 'x'.repeat(1_200_000));
    console.log = () => {};

    installFileLog(true);
    console.log('fresh');
    restore();

    expect(existsSync(`${file}.old`)).toBe(true);
    expect(statSync(file).size).toBeLessThan(1_000);
    expect(readFileSync(file, 'utf8')).toContain('fresh');
  });
});

test('logFile lives in the data directory, wherever that is', () => {
  inTempData((dir) => expect(logFile()).toBe(join(dir, 'steward.log')));
});
