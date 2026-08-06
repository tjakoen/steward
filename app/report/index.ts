// Assembling a bug report from this running instance (0015).
//
// One function, called by `GET /report` and by the tests. Everything it reads is either a
// process fact or a repository it was handed, so a test can build a whole report against
// an in-memory database and a temporary log file.

import { homedir, release } from 'node:os';
import { PACKAGED, VERSION } from '../paths.ts';
import { readSettings } from '../mail/digest.ts';
import { resolveChrome } from '../pdf/print.ts';
import type { Repositories } from '../repo/ports.ts';
import { buildBody, defaultTitle, type BuiltBody } from './body.ts';
import { facts, normaliseScreen, type Fact } from './facts.ts';
import { readLogTail, type LogTail } from './tail.ts';

export interface ReportDeps {
  repos: Repositories;
  /** `googleAuth.status()` — the two booleans. The account address is never read here. */
  google: { configured: boolean; connected: boolean };
  /** `sheetsMirror.state()`. Only whether a mirror exists survives into the body. */
  mirror: { configured: boolean; connected: boolean; url: string | null };
  /** `?from=` when we control the link, else the `Referer` header, else nothing. */
  screen?: string | null;
  /** Test seams. */
  packaged?: boolean;
  logPath?: string;
  home?: string | null;
}

export interface Report extends BuiltBody {
  title: string;
  facts: Fact[];
  screen: string;
  log: LogTail;
}

/**
 * Every value currently in the `settings` table.
 *
 * A sweep, not a list of keys: a list would have to be edited by whoever adds the next
 * secret. This is the one thing the redactor needs that `get`/`set`/`remove` could not
 * give it, and the whole reason `keys()` exists.
 */
const storedValues = (repos: Repositories): (string | null)[] =>
  repos.settings.keys().map((k) => repos.settings.get(k));

export async function buildReport(deps: ReportDeps): Promise<Report> {
  const packaged = deps.packaged ?? PACKAGED;
  const screen = normaliseScreen(deps.screen);
  const log = await readLogTail({ packaged, ...(deps.logPath ? { path: deps.logPath } : {}) });
  const digest = readSettings(deps.repos.settings);

  const list = facts({
    version: VERSION,
    packaged,
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    bunVersion: Bun.version,
    uptimeSeconds: process.uptime(),
    dataDirOverridden: Boolean(process.env.STEWARD_DATA),
    google: { configured: deps.google.configured, connected: deps.google.connected },
    mirror: {
      configured: deps.mirror.configured,
      connected: deps.mirror.connected,
      hasMirror: Boolean(deps.mirror.url),
    },
    digest: {
      enabled: digest.enabled,
      time: digest.time,
      port: digest.port,
      hasHost: Boolean(digest.host),
      hasUser: Boolean(digest.user),
      hasRecipient: Boolean(digest.to),
      hasPassword: digest.hasPassword,
      lastSentOn: digest.lastSentOn,
    },
    chromePath: resolveChrome(),
    counts: {
      clients: deps.repos.clients.list().length,
      customers: deps.repos.customers.list().length,
      tickets: deps.repos.tickets.list().length,
      documents: deps.repos.documents.list().length,
    },
    screen,
    log: { available: log.available, hasOld: log.hasOld },
  });

  const title = defaultTitle(screen, VERSION);
  const built = buildBody({
    facts: list,
    log,
    title,
    redaction: {
      secrets: storedValues(deps.repos),
      home: deps.home === undefined ? homedir() : deps.home,
    },
  });

  return { ...built, title, facts: list, screen, log };
}
