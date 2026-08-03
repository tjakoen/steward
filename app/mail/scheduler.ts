// The clock behind the daily digest (0013).
//
// The ask is explicit that this runs WHILE THE DESKTOP APP IS OPEN. That is a real
// constraint, not a limitation to design around: STEWARD is a desktop binary, there
// is no server to host a cron, and pretending otherwise would mean a service the
// operator has not asked for and cannot see.
//
// So: a one-a-minute tick that asks whether today's digest is due and unsent.
// No timezone handling — the schedule and the operator are on the same machine.

import type { SettingsRepository } from '../repo/ports.ts';
import { DEFAULT_TIME, KEYS, parseTime, readSettings } from './digest.ts';

/** How many times a day a failing send is retried before it waits for tomorrow. */
export const MAX_ATTEMPTS = 5;

const pad = (n: number): string => String(n).padStart(2, '0');

export const localDate = (at: Date): string =>
  `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;

export const localTime = (at: Date): string => `${pad(at.getHours())}:${pad(at.getMinutes())}`;

/** Why a tick did nothing, in words. `null` means it should send. */
export type Skip = 'disabled' | 'unconfigured' | 'not-yet' | 'already-sent' | 'gave-up' | null;

/**
 * Should this tick send?
 *
 * Due means the configured `HH:MM` has PASSED — not that it is exactly now. That is
 * what makes a laptop shut at 08:00 and opened at 11:00 still send. A missed day
 * stays missed: there is no backfill, and yesterday's digest would be a worse copy
 * of today's anyway, since the digest is about what is pending *now*.
 */
export function dueNow(settings: SettingsRepository, at: Date): Skip {
  const d = readSettings(settings);
  if (!d.enabled) return 'disabled';
  if (!d.host || !d.to || !d.user || !d.hasPassword) return 'unconfigured';

  const today = localDate(at);
  if (d.lastSentOn === today) return 'already-sent';
  if (attemptsToday(settings, today) >= MAX_ATTEMPTS) return 'gave-up';
  if (localTime(at) < (parseTime(d.time) ?? DEFAULT_TIME)) return 'not-yet';
  return null;
}

/** The per-day counter, stored as `YYYY-MM-DD:n` so yesterday's count cannot leak into today. */
export function attemptsToday(settings: SettingsRepository, today: string): number {
  const [day, n] = (settings.get(KEYS.attempts) ?? '').split(':');
  return day === today ? Number(n) || 0 : 0;
}

function recordAttempt(settings: SettingsRepository, today: string): void {
  settings.set(KEYS.attempts, `${today}:${attemptsToday(settings, today) + 1}`);
}

export interface SchedulerDeps {
  settings: SettingsRepository;
  send: (today: string) => Promise<{ ok: boolean; error?: string; attachments: number; tickets: number }>;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface Scheduler {
  /** One check. Exported so a test — and the Settings card — can drive it directly. */
  tick(): Promise<Skip | 'sent' | 'failed' | 'busy'>;
  /** Start the minute timer. Returns a stop function. */
  start(): () => void;
}

const MINUTE = 60_000;

export function makeDigestScheduler(deps: SchedulerDeps): Scheduler {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  let running = false;

  async function tick(): Promise<Skip | 'sent' | 'failed' | 'busy'> {
    // A send that outlives its minute must not be started twice.
    if (running) return 'busy';
    const at = now();
    const skip = dueNow(deps.settings, at);
    if (skip) return skip;

    const today = localDate(at);
    running = true;
    // Stamped BEFORE the attempt, and it is the idempotency key: a tick that finds
    // today's date already here does nothing. On failure it is cleared again, so the
    // next tick retries — capped by the attempt counter, or a bad password would
    // mean a send attempt every minute until midnight.
    deps.settings.set(KEYS.lastSentOn, today);
    recordAttempt(deps.settings, today);
    try {
      const r = await deps.send(today);
      if (r.ok) {
        deps.settings.set(KEYS.lastResult,
          `${new Date(at).toISOString()} sent ${r.tickets} pending, ${r.attachments} attached`);
        log(`[digest] sent — ${r.tickets} pending, ${r.attachments} attached`);
        return 'sent';
      }
      deps.settings.remove(KEYS.lastSentOn);
      deps.settings.set(KEYS.lastResult, `${new Date(at).toISOString()} failed: ${r.error ?? 'unknown'}`);
      // Visible or the feature is a rumour: this goes to the console, and when
      // packaged the console is mirrored into steward.log (0010).
      log(`[digest] FAILED: ${r.error ?? 'unknown'}`);
      return 'failed';
    } catch (e) {
      deps.settings.remove(KEYS.lastSentOn);
      const why = e instanceof Error ? e.message : String(e);
      deps.settings.set(KEYS.lastResult, `${new Date(at).toISOString()} failed: ${why}`);
      log(`[digest] FAILED: ${why}`);
      return 'failed';
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start() {
      // `.unref()` so a timer never holds the process open on shutdown — the same
      // reason the SSE heartbeat in server.ts has one.
      const timer = setInterval(() => { void tick(); }, MINUTE);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  };
}
