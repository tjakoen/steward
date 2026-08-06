import { test, expect } from 'bun:test';
import type { SettingsRepository } from '../repo/ports.ts';
import { KEYS } from './digest.ts';
import { attemptsToday, dueNow, localDate, localTime, makeDigestScheduler, MAX_ATTEMPTS } from './scheduler.ts';

function memorySettings(seed: Record<string, string> = {}): SettingsRepository {
  const map = new Map(Object.entries(seed));
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => { map.set(k, v); },
    remove: (k) => { map.delete(k); },
    keys: () => [...map.keys()],
  };
}

/** A fully configured, enabled digest at 08:00. */
const configured = (over: Record<string, string> = {}) => memorySettings({
  [KEYS.enabled]: '1', [KEYS.time]: '08:00', [KEYS.to]: 'admin@example.com',
  [KEYS.host]: 'smtp.example.com', [KEYS.user]: 'me@example.com', [KEYS.password]: 'secret',
  ...over,
});

/** Local time, built the way the scheduler reads it — no timezone in the picture. */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 7, day, hour, minute);

test('local date and time are read off the wall clock', () => {
  expect(localDate(at(3, 9, 5))).toBe('2026-08-03');
  expect(localTime(at(3, 9, 5))).toBe('09:05');
});

test('before the configured time, nothing happens', () => {
  expect(dueNow(configured(), at(3, 7, 59))).toBe('not-yet');
});

test('at the configured minute, it is due', () => {
  expect(dueNow(configured(), at(3, 8, 0))).toBe(null);
});

// The whole point of "has the time passed", rather than "is it exactly now".
test('a laptop shut at 08:00 and opened at 11:00 still sends', () => {
  expect(dueNow(configured(), at(3, 11, 0))).toBe(null);
});

test("today's stamp is the idempotency key — a second tick does nothing", () => {
  expect(dueNow(configured({ [KEYS.lastSentOn]: '2026-08-03' }), at(3, 11, 0))).toBe('already-sent');
});

test("yesterday's stamp does not stop today", () => {
  expect(dueNow(configured({ [KEYS.lastSentOn]: '2026-08-02' }), at(3, 11, 0))).toBe(null);
});

test('a missed day is not backfilled — only today is ever considered', () => {
  // Nothing was sent on the 2nd, and nothing about the 3rd's tick refers to it.
  const settings = configured({ [KEYS.lastSentOn]: '2026-08-01' });
  expect(dueNow(settings, at(3, 11, 0))).toBe(null);
  settings.set(KEYS.lastSentOn, '2026-08-03');
  expect(dueNow(settings, at(3, 11, 0))).toBe('already-sent');
});

test('off means off, and half-configured means unconfigured', () => {
  expect(dueNow(configured({ [KEYS.enabled]: '0' }), at(3, 11))).toBe('disabled');
  expect(dueNow(configured({ [KEYS.host]: '' }), at(3, 11))).toBe('unconfigured');
  expect(dueNow(configured({ [KEYS.password]: '' }), at(3, 11))).toBe('unconfigured');
  expect(dueNow(configured({ [KEYS.to]: '' }), at(3, 11))).toBe('unconfigured');
});

test("the attempt counter is per day, so yesterday's failures do not count", () => {
  const settings = configured({ [KEYS.attempts]: `2026-08-02:${MAX_ATTEMPTS}` });
  expect(attemptsToday(settings, '2026-08-03')).toBe(0);
  expect(dueNow(settings, at(3, 11))).toBe(null);
});

test('a failing send is retried, but not forever', async () => {
  const settings = configured();
  let calls = 0;
  const s = makeDigestScheduler({
    settings,
    now: () => at(3, 11),
    send: async () => { calls++; return { ok: false, error: 'no route to host', attachments: 0, tickets: 0 }; },
  });
  for (let i = 0; i < MAX_ATTEMPTS + 3; i++) await s.tick();
  expect(calls).toBe(MAX_ATTEMPTS);
  expect(await s.tick()).toBe('gave-up');
});

test('a failure clears the stamp so the next tick retries, and records why', async () => {
  const settings = configured();
  const s = makeDigestScheduler({
    settings, now: () => at(3, 11),
    send: async () => ({ ok: false, error: 'no route to host', attachments: 0, tickets: 0 }),
  });
  expect(await s.tick()).toBe('failed');
  expect(settings.get(KEYS.lastSentOn)).toBe(null);
  expect(settings.get(KEYS.lastResult)).toContain('no route to host');
});

test('a success stamps the day and then refuses to send again', async () => {
  const settings = configured();
  let calls = 0;
  const s = makeDigestScheduler({
    settings, now: () => at(3, 11),
    send: async () => { calls++; return { ok: true, attachments: 2, tickets: 7 }; },
  });
  expect(await s.tick()).toBe('sent');
  expect(await s.tick()).toBe('already-sent');
  expect(calls).toBe(1);
  expect(settings.get(KEYS.lastSentOn)).toBe('2026-08-03');
  expect(settings.get(KEYS.lastResult)).toContain('7 pending, 2 attached');
});

test('clearing the stamp by hand makes it send again — the verify-pass move', async () => {
  const settings = configured();
  let calls = 0;
  const s = makeDigestScheduler({
    settings, now: () => at(3, 11), send: async () => { calls++; return { ok: true, attachments: 0, tickets: 0 }; },
  });
  await s.tick();
  settings.remove(KEYS.lastSentOn);
  settings.remove(KEYS.attempts);
  await s.tick();
  expect(calls).toBe(2);
});

test('a send that throws is a failure, not a dead app', async () => {
  const settings = configured();
  const s = makeDigestScheduler({
    settings, now: () => at(3, 11), send: async () => { throw new Error('chrome died'); },
  });
  expect(await s.tick()).toBe('failed');
  expect(settings.get(KEYS.lastResult)).toContain('chrome died');
});

test('a send still running when the next minute arrives is not started twice', async () => {
  const settings = configured();
  let calls = 0;
  let release: () => void = () => {};
  const s = makeDigestScheduler({
    settings, now: () => at(3, 11),
    send: () => { calls++; return new Promise((r) => { release = () => r({ ok: true, attachments: 0, tickets: 0 }); }); },
  });
  const first = s.tick();
  expect(await s.tick()).toBe('busy');
  release();
  await first;
  expect(calls).toBe(1);
});
