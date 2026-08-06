// Assembling and sending the daily digest (0013).
//
// This is the only file that knows both halves: the repositories on one side, the
// renderer and the transport on the other. Everything it depends on arrives as a
// parameter, so a test can build a digest and "send" it without a browser, a
// mailbox or a clock.

import type { Client, Customer, Ticket } from '../domain/types.ts';
import type { Repositories, SettingsRepository } from '../repo/ports.ts';
import type { PrintOptions } from '../pdf/print.ts';
import type { Attachment } from './mime.ts';
import type { SmtpConfig } from './smtp.ts';
import { documentPrintOptions } from '../view/doc.ts';
import {
  digestBody, digestFileName, digestFor, digestSubject, isPending,
  renderDigestDocument, type ClientDigest, type PendingTicket,
} from '../view/digest.ts';

// ---- settings ---------------------------------------------------------------
// The k/v table, following the doctrine 0006 set for the Google tokens: the secret
// is never audited, never rendered back to the page and never in a URL.

/**
 * Google displays an app password as four groups of four — `abcd efgh ijkl mnop` — and
 * everybody pastes it that way. Those spaces are presentation: Gmail's SMTP wants the
 * sixteen characters, and given the spaces it answers
 * `535 5.7.8 Username and Password not accepted`, which reads exactly like a wrong
 * password and sends people back to Google to make another one that fails the same way.
 *
 * So the spaces come out — but ONLY when what is left is the app-password shape, sixteen
 * letters. Any other secret is stored exactly as typed, because a real SMTP password is
 * allowed to contain a space and silently eating it would be the worse bug.
 */
export function normalisePassword(raw: string): string {
  const squeezed = raw.replace(/\s+/g, '');
  return /^[a-z]{16}$/i.test(squeezed) ? squeezed : raw.trim();
}

export const KEYS = {
  enabled: 'digest.enabled',
  time: 'digest.time',
  to: 'digest.to',
  host: 'digest.smtp_host',
  port: 'digest.smtp_port',
  user: 'digest.smtp_user',
  password: 'digest.smtp_password',
  from: 'digest.smtp_from',
  lastSentOn: 'digest.last_sent_on',
  lastResult: 'digest.last_result',
  attempts: 'digest.attempts',
} as const;

/** Implicit TLS. 587 with STARTTLS is a different conversation — see smtp.ts. */
export const DEFAULT_PORT = 465;
export const DEFAULT_TIME = '08:00';

/** Everything about the digest EXCEPT the password, which never leaves this module. */
export interface DigestSettings {
  enabled: boolean;
  time: string;
  to: string;
  host: string;
  port: number;
  user: string;
  from: string;
  /** Whether a password is stored. Never the password itself. */
  hasPassword: boolean;
  /**
   * Enough shape to diagnose a rejected login WITHOUT showing the secret: how long it is,
   * and whether it is the sixteen-letter Gmail app-password shape. A `535` against Gmail
   * is almost always an account password or a copied-with-spaces one, and neither is
   * distinguishable from a genuinely wrong password unless the card says something.
   */
  passwordLength: number;
  passwordLooksLikeAppPassword: boolean;
  lastSentOn: string;
  lastResult: string;
}

const s = (v: string | null): string => (v ?? '').trim();

export function readSettings(settings: SettingsRepository): DigestSettings {
  const user = s(settings.get(KEYS.user));
  const pw = settings.get(KEYS.password) ?? '';
  return {
    enabled: s(settings.get(KEYS.enabled)) === '1',
    time: s(settings.get(KEYS.time)) || DEFAULT_TIME,
    to: s(settings.get(KEYS.to)),
    host: s(settings.get(KEYS.host)),
    port: Number(s(settings.get(KEYS.port))) || DEFAULT_PORT,
    user,
    // An empty From means "the account you authenticate as", which is what almost
    // every operator means and what almost every host requires anyway.
    from: s(settings.get(KEYS.from)) || user,
    hasPassword: pw !== '',
    passwordLength: pw.length,
    passwordLooksLikeAppPassword: /^[a-z]{16}$/i.test(pw),
    lastSentOn: s(settings.get(KEYS.lastSentOn)),
    lastResult: s(settings.get(KEYS.lastResult)),
  };
}

/** "08:00", or null when it is not a time of day. */
export function parseTime(value: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export function smtpConfig(settings: SettingsRepository): SmtpConfig {
  const d = readSettings(settings);
  return {
    host: d.host, port: d.port, user: d.user,
    password: s(settings.get(KEYS.password)),
    from: d.from,
  };
}

// ---- gathering --------------------------------------------------------------

export interface Workspace {
  digests: ClientDigest[];
  /** Every ticket there is, so the empty case can say what "nothing" is out of. */
  ticketTotal: number;
}

/**
 * Everything pending, grouped by client.
 *
 * The documents of every pending ticket are read in ONE query rather than one per
 * ticket — that is what `forEntities` exists for. A ticket whose customer or client
 * has gone is skipped: there is no branding to render it in, and inventing some
 * would put one client's work on another's letterhead.
 */
export function buildWorkspace(repos: Repositories, today: string): Workspace {
  const tickets = repos.tickets.list();
  const pending = tickets.filter(isPending);
  const docs = repos.documents.forEntities('ticket', pending.map((t) => t.id));

  const customers = new Map<string, Customer>(repos.customers.list().map((c) => [c.id, c]));
  const byClient = new Map<string, PendingTicket[]>();
  for (const ticket of pending) {
    const customer = customers.get(ticket.customerId) ?? null;
    if (!customer) continue;
    const list = byClient.get(customer.clientId);
    const item: PendingTicket = { ticket, customer, documents: docs.get(ticket.id) ?? [] };
    if (list) list.push(item); else byClient.set(customer.clientId, [item]);
  }

  const digests = repos.clients.list()
    .map((client: Client) => digestFor(client, byClient.get(client.id) ?? [], today))
    .filter((d) => d.total > 0);

  return { digests, ticketTotal: tickets.length };
}

// ---- sending ----------------------------------------------------------------

export interface DigestDeps {
  repos: Repositories;
  print: (html: string, opts?: PrintOptions) => Promise<Uint8Array>;
  send: (config: SmtpConfig, msg: {
    to: string; from: string; subject: string; text: string; attachments?: Attachment[];
  }) => Promise<{ ok: boolean; error?: string }>;
  /** Recorded against every client whose report went out. Not the body — just that it did. */
  audit?: (clientId: string, recipient: string, count: number) => void;
  log?: (line: string) => void;
}

export interface DigestOutcome {
  ok: boolean;
  error?: string;
  /** How many client reports were attached. Zero is a valid, deliberate send. */
  attachments: number;
  tickets: number;
  subject: string;
}

/**
 * Render every client's report and send the one email that carries them.
 *
 * One email, one attachment per client with pending work: a single combined PDF
 * would have to pick somebody's colours, and the answer to "whose?" is nobody's.
 *
 * An empty digest still sends. A silent morning is indistinguishable from a
 * scheduler that died in the night.
 */
export async function sendDigest(deps: DigestDeps, today: string): Promise<DigestOutcome> {
  const settings = readSettings(deps.repos.settings);

  // Checked BEFORE anything is rendered. Driving Chrome once per client to then
  // discover there is nowhere to send it is a slow way to reach the same sentence.
  const missing = [
    settings.host ? '' : 'host', settings.user ? '' : 'user',
    settings.hasPassword ? '' : 'password', settings.to ? '' : 'recipient',
  ].filter(Boolean);
  if (missing.length) {
    return { ok: false, error: `mail is not configured: no ${missing.join(', ')}`,
      attachments: 0, tickets: 0, subject: '' };
  }

  const { digests, ticketTotal } = buildWorkspace(deps.repos, today);
  const subject = digestSubject(digests, today);
  const text = digestBody(digests, today, ticketTotal);

  const attachments: Attachment[] = [];
  for (const d of digests) {
    // One render failure must not cost the operator the whole morning's mail — the
    // other clients' reports still go, and the body still names every count.
    try {
      const bytes = await deps.print(renderDigestDocument(d, today, ticketTotal),
        documentPrintOptions(d.client));
      attachments.push({ filename: digestFileName(d, today), mimeType: 'application/pdf', bytes });
    } catch (e) {
      deps.log?.(`[digest] could not render ${d.client.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const result = await deps.send(smtpConfig(deps.repos.settings), {
    to: settings.to, from: settings.from, subject, text, attachments,
  });

  const tickets = digests.reduce((sum, d) => sum + d.total, 0);
  if (result.ok && deps.audit) {
    // Audited against each client whose work left the building, because that is the
    // record it happened TO. The recipient is kept; the message body is not.
    for (const d of digests) deps.audit(d.client.id, settings.to, d.total);
  }
  return { ok: result.ok, error: result.error, attachments: attachments.length, tickets, subject };
}
