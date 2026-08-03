import { test, expect } from 'bun:test';
import { base64Lines, buildMessage, dataPayload, encodeHeader, rfc2822Date } from './mime.ts';

const AT = new Date('2026-08-03T08:00:00Z');

test('base64 wraps at 76 columns', () => {
  const lines = base64Lines(new Uint8Array(300)).split('\r\n');
  expect(lines.length).toBeGreaterThan(1);
  for (const l of lines) expect(l.length).toBeLessThanOrEqual(76);
});

test('an ASCII header is left alone', () => {
  expect(encodeHeader('STEWARD digest')).toBe('STEWARD digest');
});

test("STEWARD's own em-dashed subject becomes an encoded-word", () => {
  const encoded = encodeHeader('STEWARD — 7 pending tickets, 3 August 2026');
  expect(encoded).toContain('=?UTF-8?B?');
  // Decoding any one word must give back a piece of the original, so the split
  // never lands inside a multi-byte character.
  const joined = encoded.split('\r\n ')
    .map((w) => Buffer.from(w.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, ''), 'base64').toString('utf8'))
    .join('');
  expect(joined).toBe('STEWARD — 7 pending tickets, 3 August 2026');
});

test('every encoded-word fits inside the 75-character limit', () => {
  for (const word of encodeHeader('—'.repeat(200)).split('\r\n ')) {
    expect(word.length).toBeLessThanOrEqual(75);
  }
});

test('the date is RFC 5322 shaped', () => {
  expect(rfc2822Date(AT)).toMatch(/^[A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}$/);
});

test('a message with no attachments is a plain text/plain part', () => {
  const m = buildMessage(
    { to: 'a@b.c', from: 'me@x.y', subject: 'hi', text: 'body' }, 'BOUND', AT);
  expect(m).toContain('Content-Type: text/plain; charset="utf-8"');
  expect(m).not.toContain('multipart/mixed');
  expect(Buffer.from(m.split('\r\n').at(-1)!, 'base64').toString('utf8')).toBe('body');
});

test('attachments arrive as multipart/mixed with a closing boundary', () => {
  const m = buildMessage({
    to: 'a@b.c', from: 'me@x.y', subject: 'hi', text: 'body',
    attachments: [{ filename: 'Acme — pending.pdf', mimeType: 'application/pdf',
      bytes: new Uint8Array([1, 2, 3]) }],
  }, 'BOUND', AT);
  expect(m).toContain('Content-Type: multipart/mixed; boundary="BOUND"');
  expect(m).toContain('--BOUND');
  expect(m).toContain('--BOUND--');
  expect(m).toContain('Content-Transfer-Encoding: base64');
});

test('a non-ASCII filename gets both an ASCII fallback and RFC 2231', () => {
  const m = buildMessage({
    to: 'a@b.c', from: 'me@x.y', subject: 'hi', text: '',
    attachments: [{ filename: 'Acme — pending.pdf', mimeType: 'application/pdf', bytes: new Uint8Array([1]) }],
  }, 'BOUND', AT);
  expect(m).toContain('filename="Acme _ pending.pdf"');
  expect(m).toContain("filename*=UTF-8''Acme%20%E2%80%94%20pending.pdf");
});

// The one that truncates mail silently: a body line starting with `.` ends DATA.
test('dot-stuffing doubles a leading dot, and only a leading one', () => {
  expect(dataPayload('.hidden\nnot .hidden')).toBe('..hidden\r\nnot .hidden\r\n.\r\n');
});

test('every line ending becomes CRLF, whatever it started as', () => {
  expect(dataPayload('a\nb\r\nc\rd')).toBe('a\r\nb\r\nc\r\nd\r\n.\r\n');
});

test('the payload terminates with the lone dot the server waits for', () => {
  expect(dataPayload('x').endsWith('\r\n.\r\n')).toBe(true);
});
