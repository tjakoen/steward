import { test, expect } from 'bun:test';
import {
  makeByteQueue, makeReplyParser, sendMail, type SmtpConfig, type SmtpTransport,
} from './smtp.ts';

const CONFIG: SmtpConfig = {
  host: 'smtp.example.com', port: 465, user: 'me@example.com',
  password: 'app-password', from: 'me@example.com',
};

const MSG = { to: 'you@example.com', from: 'me@example.com', subject: 'hi', text: 'body' };

// ---- the reply parser -------------------------------------------------------
// "Every reply is multi-line until it is not." Reading one line and moving on
// works against one server and hangs against the next.

test('a single-line reply is one reply', () => {
  const seen: unknown[] = [];
  makeReplyParser((r) => seen.push(r))('220 smtp.example.com ready\r\n');
  expect(seen).toEqual([{ code: 220, lines: ['smtp.example.com ready'] }]);
});

test('a hyphen continues the reply; only a space ends it', () => {
  const seen: { code: number; lines: string[] }[] = [];
  const feed = makeReplyParser((r) => seen.push(r));
  feed('250-smtp.example.com\r\n250-PIPELINING\r\n250-SIZE 35882577\r\n');
  expect(seen).toHaveLength(0); // still going
  feed('250 AUTH LOGIN PLAIN\r\n');
  expect(seen).toHaveLength(1);
  expect(seen[0].code).toBe(250);
  expect(seen[0].lines).toHaveLength(4);
});

test('a reply split across TCP chunks is still one reply', () => {
  const seen: { code: number; lines: string[] }[] = [];
  const feed = makeReplyParser((r) => seen.push(r));
  feed('23');
  feed('5 2.7.0 Accepted');
  expect(seen).toHaveLength(0);
  feed('\r\n');
  expect(seen).toEqual([{ code: 235, lines: ['2.7.0 Accepted'] }]);
});

test('two replies in one chunk are two replies', () => {
  const seen: { code: number }[] = [];
  makeReplyParser((r) => seen.push(r))('250 ok\r\n354 go ahead\r\n');
  expect(seen.map((r) => r.code)).toEqual([250, 354]);
});

// ---- the conversation -------------------------------------------------------

/** A server that answers each command with a scripted reply, recording what it heard. */
function fakeServer(script: string[]): { transport: SmtpTransport; said: string[] } {
  const said: string[] = [];
  let step = 0;
  const transport: SmtpTransport = {
    async open(_config, onData) {
      queueMicrotask(() => onData(script[step++]));
      return {
        write(raw) {
          said.push(raw);
          if (step < script.length) queueMicrotask(() => onData(script[step++]));
        },
        close() {},
      };
    },
  };
  return { transport, said };
}

const HAPPY = [
  '220 ready\r\n',
  '250-smtp.example.com\r\n250 AUTH PLAIN\r\n', // EHLO, multi-line on purpose
  '235 authenticated\r\n',
  '250 sender ok\r\n',
  '250 recipient ok\r\n',
  '354 go ahead\r\n',
  '250 queued as ABC123\r\n',
  '221 bye\r\n',
];

test('a clean send walks EHLO → AUTH → MAIL → RCPT → DATA → QUIT', async () => {
  const { transport, said } = fakeServer(HAPPY);
  const r = await sendMail(CONFIG, MSG, { transport, boundary: 'B', at: new Date('2026-08-03T08:00:00Z') });
  expect(r.ok).toBe(true);
  const commands = said.map((s) => s.split(' ')[0].trim());
  expect(commands.slice(0, 3)).toEqual(['EHLO', 'AUTH', 'MAIL']);
  expect(said.some((s) => s.startsWith('RCPT TO:<you@example.com>'))).toBe(true);
  expect(said.some((s) => s.startsWith('DATA'))).toBe(true);
  expect(said.some((s) => s.endsWith('\r\n.\r\n'))).toBe(true);
  expect(said.some((s) => s.startsWith('QUIT'))).toBe(true);
});

test('AUTH PLAIN sends the NUL-separated blob, and nothing readable', async () => {
  const { transport, said } = fakeServer(HAPPY);
  await sendMail(CONFIG, MSG, { transport });
  const auth = said.find((s) => s.startsWith('AUTH PLAIN'))!;
  expect(auth).not.toContain('app-password');
  const decoded = Buffer.from(auth.slice('AUTH PLAIN '.length).trim(), 'base64').toString('utf8');
  expect(decoded).toBe('\0me@example.com\0app-password');
});

test('a rejected password is a legible failure, not a throw', async () => {
  const { transport } = fakeServer([
    '220 ready\r\n', '250 ok\r\n', '535 5.7.8 Username and Password not accepted\r\n',
  ]);
  const r = await sendMail(CONFIG, MSG, { transport });
  expect(r.ok).toBe(false);
  expect(r.error).toContain('the password was refused');
  expect(r.error).toContain('535');
});

test('a failure never carries the password with it', async () => {
  const { transport } = fakeServer(['220 ready\r\n', '250 ok\r\n', '535 no\r\n']);
  const r = await sendMail(CONFIG, MSG, { transport });
  expect(r.error).not.toContain('app-password');
});

test('251 is an acceptance — the recipient is elsewhere, not refused', async () => {
  const { transport } = fakeServer([
    '220 ready\r\n', '250 ok\r\n', '235 ok\r\n', '250 ok\r\n',
    '251 User not local; will forward\r\n', '354 go\r\n', '250 queued\r\n', '221 bye\r\n',
  ]);
  expect((await sendMail(CONFIG, MSG, { transport })).ok).toBe(true);
});

test('an unconfigured send says what is missing and opens no socket', async () => {
  let opened = false;
  const transport: SmtpTransport = { async open() { opened = true; throw new Error('nope'); } };
  const r = await sendMail({ ...CONFIG, host: '', password: '' }, MSG, { transport });
  expect(r.ok).toBe(false);
  expect(r.error).toContain('host');
  expect(r.error).toContain('password');
  expect(opened).toBe(false);
});

test('no recipient is refused before anything is dialled', async () => {
  const r = await sendMail(CONFIG, { ...MSG, to: '' }, {
    transport: { async open() { throw new Error('should not connect'); } },
  });
  expect(r.error).toContain('no recipient');
});

// ---- the short write that truncated the first real message ------------------
//
// Everything above passes against a scripted server that accepts whole strings. A real
// socket does not: `write` returns the bytes it took, and a base64 PDF is far past the
// TLS buffer. The body arrived without its terminator, Gmail waited for the rest, and
// the failure surfaced 20s later as "smtp.gmail.com stopped responding".

/** A sink that never takes more than `cap` bytes at a time, like a full socket. */
function cappedSink(cap: number) {
  const got: number[] = [];
  let closed = false;
  return {
    received: () => new Uint8Array(got),
    stall: () => { closed = true; },
    resume: () => { closed = false; },
    write: (bytes: Uint8Array): number => {
      if (closed) return 0;
      const n = Math.min(cap, bytes.length);
      for (let i = 0; i < n; i++) got.push(bytes[i]);
      return n;
    },
  };
}

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

test('a payload larger than one write still arrives whole', () => {
  const sink = cappedSink(8);
  const q = makeByteQueue(sink.write);
  const body = 'x'.repeat(1000) + '\r\n.\r\n';
  q.push(body);
  expect(q.unsent()).toBe(0);
  expect(decode(sink.received())).toBe(body);
  // The terminator is the whole point: without it the server never answers.
  expect(decode(sink.received()).endsWith('\r\n.\r\n')).toBe(true);
});

test('a stalled socket holds the remainder, and drain sends it', () => {
  const sink = cappedSink(16);
  const q = makeByteQueue(sink.write);
  sink.stall();
  q.push('hello world, this is longer than one write');
  expect(q.unsent()).toBeGreaterThan(0);          // nothing lost, nothing sent
  expect(sink.received()).toHaveLength(0);

  sink.resume();
  q.drain();
  expect(q.unsent()).toBe(0);
  expect(decode(sink.received())).toBe('hello world, this is longer than one write');
});

test('writes queued while stalled keep their order', () => {
  const sink = cappedSink(4);
  const q = makeByteQueue(sink.write);
  sink.stall();
  q.push('AAAA');
  q.push('BBBB');
  sink.resume();
  q.drain();
  expect(decode(sink.received())).toBe('AAAABBBB');
});

test('a multi-byte character is never cut in half by a short write', () => {
  // The queue counts BYTES, so slicing a UTF-8 string by a byte count would split a
  // character across two writes and corrupt it. Encoding first is what prevents that.
  const sink = cappedSink(1); // one byte at a time: every character is split if it can be
  const q = makeByteQueue(sink.write);
  q.push('née — café ☕');
  expect(decode(sink.received())).toBe('née — café ☕');
});
