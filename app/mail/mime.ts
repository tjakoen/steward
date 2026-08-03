// A MIME message, built by hand (0013).
//
// No mail library, for the same reason 0004 drove Chrome over a raw WebSocket rather
// than taking puppeteer — and 0009 gives it a second one: `bun build --compile` bundles
// every dependency into the binary, so a dependency is weight the operator downloads.
// What is actually needed here is a multipart/mixed body with base64 attachments, and
// that is this file.
//
// Pure string building, no socket: everything below is testable without a mailbox.

export interface Attachment {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface MailMessage {
  to: string;
  from: string;
  subject: string;
  /** Plain text. The branded artefact is the attachment, not the body. */
  text: string;
  attachments?: Attachment[];
}

/** Base64, wrapped at 76 columns as MIME requires. */
export function base64Lines(bytes: Uint8Array): string {
  const b64 = Buffer.from(bytes).toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join('\r\n');
}

const isAscii = (s: string): boolean => !/[^\x20-\x7e]/.test(s);

/**
 * A header value that carries non-ASCII, as RFC 2047 encoded-words.
 *
 * STEWARD's own subject line contains an em dash, so this is not a theoretical
 * case — an unencoded one arrives as mojibake or gets the message rejected.
 * Encoded-words are capped at 75 characters INCLUDING the `=?UTF-8?B?…?=`
 * wrapper, so the payload is chunked; chunking on whole UTF-8 characters, never
 * on bytes, or a split multi-byte sequence becomes two replacement characters.
 */
export function encodeHeader(value: string): string {
  if (isAscii(value)) return value;
  const budget = 75 - '=?UTF-8?B?'.length - '?='.length;
  const perChunk = Math.floor(budget / 4) * 3; // base64 inflates 3 bytes to 4 chars
  const words: string[] = [];
  let chunk: string[] = [];
  let size = 0;
  const flush = () => {
    if (!chunk.length) return;
    words.push(`=?UTF-8?B?${Buffer.from(chunk.join(''), 'utf8').toString('base64')}?=`);
    chunk = []; size = 0;
  };
  for (const ch of value) {
    const bytes = Buffer.byteLength(ch, 'utf8');
    if (size + bytes > perChunk) flush();
    chunk.push(ch); size += bytes;
  }
  flush();
  // Folded onto continuation lines: adjacent encoded-words are joined by the
  // reader with no space, which is exactly what is wanted here.
  return words.join('\r\n ');
}

/**
 * A filename both an old client and a new one can read: an ASCII fallback in
 * `filename`, and the real thing in RFC 2231 `filename*`. Client names carry
 * em dashes, so the fallback is not decoration.
 */
const asciiFilename = (name: string): string =>
  name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');

function dispositionFilename(name: string): string {
  const encoded = encodeURIComponent(name).replace(/'/g, '%27');
  return `filename="${asciiFilename(name)}"; filename*=UTF-8''${encoded}`;
}

/** RFC 5322 date. Fixed-format and in English, which the spec requires. */
export function rfc2822Date(at: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n: number) => String(n).padStart(2, '0');
  const offset = -at.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return (
    `${days[at.getDay()]}, ${at.getDate()} ${months[at.getMonth()]} ${at.getFullYear()} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())} ` +
    `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  );
}

/**
 * Build the whole message. `boundary` and `at` are parameters rather than
 * generated in here so a test can assert on a byte-exact message.
 *
 * The text part is base64 too, not 8bit: the body carries em dashes and box
 * drawing, `8BITMIME` is an extension a given host may not advertise, and a
 * base64 line can never begin with a dot.
 */
export function buildMessage(msg: MailMessage, boundary: string, at: Date): string {
  const attachments = msg.attachments ?? [];
  const head = [
    `From: ${msg.from}`,
    `To: ${msg.to}`,
    `Subject: ${encodeHeader(msg.subject)}`,
    `Date: ${rfc2822Date(at)}`,
    `MIME-Version: 1.0`,
  ];

  if (!attachments.length) {
    return [
      ...head,
      `Content-Type: text/plain; charset="utf-8"`,
      `Content-Transfer-Encoding: base64`,
      '',
      base64Lines(new TextEncoder().encode(msg.text)),
    ].join('\r\n');
  }

  const parts = [
    `--${boundary}`,
    `Content-Type: text/plain; charset="utf-8"`,
    `Content-Transfer-Encoding: base64`,
    '',
    base64Lines(new TextEncoder().encode(msg.text)),
  ];
  for (const a of attachments) {
    parts.push(
      `--${boundary}`,
      // `name` on the Content-Type is the legacy spelling some clients still read;
      // `filename` on the Content-Disposition is the one that counts.
      `Content-Type: ${a.mimeType}; name="${asciiFilename(a.filename)}"`,
      `Content-Transfer-Encoding: base64`,
      `Content-Disposition: attachment; ${dispositionFilename(a.filename)}`,
      '',
      base64Lines(a.bytes),
    );
  }
  parts.push(`--${boundary}--`, '');

  return [
    ...head,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    ...parts,
  ].join('\r\n');
}

/**
 * Prepare a message for the DATA phase.
 *
 * Two rules, both of which silently corrupt mail when missed. **CRLF everywhere**,
 * including inside the MIME structure. And **dot-stuffing**: a body line beginning
 * with `.` must be sent as `..`, or the server reads it as the end of DATA and the
 * message arrives truncated at exactly that point.
 */
export function dataPayload(message: string): string {
  const body = message
    .replace(/\r\n|\n|\r/g, '\r\n')
    .split('\r\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
  return `${body}\r\n.\r\n`;
}
