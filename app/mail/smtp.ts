// A minimal SMTP client over `Bun.connect` (0013).
//
// Implicit TLS on 465 only. `STARTTLS` on 587 is an upgrade mid-conversation and a
// second socket state; it is deliberately out of scope, and the Settings card says
// 465 rather than pretending the port is free. Should a real mailbox force it, take
// `nodemailer` rather than growing this file — the seam is `sendMail(config, message)`
// and nothing above it cares.
//
// The password is never logged, never rendered back to a page and never put in a URL.
// It reaches here from the `settings` table and goes nowhere else.

import { buildMessage, dataPayload, type MailMessage } from './mime.ts';

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  /** Envelope sender and the From header. Usually the same address as `user`. */
  from: string;
}

/** One parsed SMTP reply. `lines` excludes the three-digit codes. */
export interface Reply {
  code: number;
  lines: string[];
}

/** A server that stops answering must not hold the app open forever. */
const TIMEOUT_MS = 20_000;

/**
 * Split a byte stream into replies.
 *
 * Every reply is multi-line until it is not: a line with `-` after the code
 * (`250-STARTTLS`) means more follow, and only `250 ` with a SPACE ends it.
 * Reading one line and moving on works against one server and hangs against the
 * next — the EHLO response alone is a dozen lines on most hosts.
 */
export function makeReplyParser(emit: (r: Reply) => void): (chunk: string) => void {
  let buffer = '';
  let lines: string[] = [];
  return (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\r\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 2);
      const m = /^(\d{3})([ -])?(.*)$/.exec(line);
      if (!m) continue; // not a reply line; nothing useful to do with it
      lines.push(m[3] ?? '');
      if (m[2] !== '-') {
        emit({ code: Number(m[1]), lines });
        lines = [];
      }
    }
  };
}

/** What the transport reports back. A failure is a sentence, not a stack. */
export interface SendResult {
  ok: boolean;
  error?: string;
}

interface Conversation {
  next(): Promise<Reply>;
  say(line: string): void;
  write(raw: string): void;
  close(): void;
}

/**
 * Speak one SMTP conversation. Returns when the mail is accepted, throws with a
 * legible sentence when it is not.
 */
async function converse(config: SmtpConfig, message: string, to: string, c: Conversation): Promise<void> {
  const expect = async (what: string, ...codes: number[]): Promise<Reply> => {
    const r = await c.next();
    if (!codes.includes(r.code)) {
      throw new Error(`${what} was refused: ${r.code} ${r.lines.join(' ').trim()}`);
    }
    return r;
  };

  await expect('the connection', 220);

  // The hostname STEWARD announces itself by. A desktop machine has no name worth
  // giving, and a bracketed literal is what the spec says to send when there isn't one.
  c.say('EHLO [127.0.0.1]');
  await expect('EHLO', 250);

  // AUTH PLAIN: a single base64 blob of \0user\0password. Never log this line.
  const token = Buffer.from(`\0${config.user}\0${config.password}`, 'utf8').toString('base64');
  c.say(`AUTH PLAIN ${token}`);
  await expect('the password', 235);

  c.say(`MAIL FROM:<${config.from}>`);
  await expect('the sender address', 250);

  c.say(`RCPT TO:<${to}>`);
  // 251 is "not local, will forward" — an acceptance, and refusing it here would
  // reject perfectly deliverable mail.
  await expect('the recipient address', 250, 251);

  c.say('DATA');
  await expect('DATA', 354);

  c.write(dataPayload(message));
  await expect('the message', 250);

  c.say('QUIT');
  // Whether the server bothers to answer QUIT is its business; the mail is already
  // accepted, so a missing 221 is not a failed send.
}

/** Everything `sendMail` needs from the outside world, so a test can stand in for it. */
export interface SmtpTransport {
  open(config: SmtpConfig, onData: (chunk: string) => void): Promise<{
    write(raw: string): void;
    close(): void;
  }>;
}

const bunTransport: SmtpTransport = {
  async open(config, onData) {
    const socket = await Bun.connect({
      hostname: config.host,
      port: config.port,
      // Implicit TLS: the socket is encrypted before the greeting, which is what
      // makes 465 a different thing from 587 rather than a different number.
      tls: true,
      socket: {
        data(_s, data) { onData(new TextDecoder().decode(data)); },
        error() { /* surfaced by the reply timeout below */ },
        close() { /* ditto */ },
      },
    });
    return {
      write: (raw) => { socket.write(raw); },
      close: () => { try { socket.end(); } catch { /* already gone */ } },
    };
  },
};

/**
 * Send one message. Never throws — a mail failure is a thing to show the operator,
 * not a thing to take the app down with.
 */
export async function sendMail(
  config: SmtpConfig,
  msg: MailMessage,
  opts: { transport?: SmtpTransport; at?: Date; boundary?: string } = {},
): Promise<SendResult> {
  const missing = (['host', 'user', 'password', 'from'] as const).filter((k) => !config[k]?.trim());
  if (missing.length) return { ok: false, error: `mail is not configured: no ${missing.join(', ')}` };
  if (!msg.to.trim()) return { ok: false, error: 'mail is not configured: no recipient' };

  const at = opts.at ?? new Date();
  const boundary = opts.boundary ?? `steward-${at.getTime().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const message = buildMessage({ ...msg, from: msg.from || config.from }, boundary, at);

  const queued: Reply[] = [];
  let waiter: ((r: Reply) => void) | null = null;
  const feed = makeReplyParser((r) => {
    const w = waiter;
    if (w) { waiter = null; w(r); } else queued.push(r);
  });

  let conn: { write(raw: string): void; close(): void } | null = null;
  try {
    conn = await (opts.transport ?? bunTransport).open(config, feed);
    const socket = conn;
    const c: Conversation = {
      next: () => {
        const ready = queued.shift();
        if (ready) return Promise.resolve(ready);
        return new Promise<Reply>((resolve, reject) => {
          waiter = resolve;
          setTimeout(() => {
            if (waiter !== resolve) return;
            waiter = null;
            reject(new Error(`${config.host} stopped responding`));
          }, TIMEOUT_MS).unref?.();
        });
      },
      say: (line) => socket.write(`${line}\r\n`),
      write: (raw) => socket.write(raw),
      close: () => socket.close(),
    };
    await converse(config, message, msg.to, c);
    return { ok: true };
  } catch (e) {
    // The message deliberately does not include the config: a log line that carries
    // a password is a leak that outlives the failure it was written for.
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    conn?.close();
  }
}
