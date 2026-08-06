// The end of `steward.log`, read by byte offset (0015).
//
// 0010 writes that log — synchronously, so ordering survives a crash — and caps it at a
// megabyte with one `.old` generation kept. Nothing has ever read it back. Reading it is
// therefore just a question of taking the end.

import { logFile } from '../log.ts';

/**
 * Comfortably more than can ever survive the 8 KB URL budget, and the excess costs one
 * cheap read from a local file. The budget does the real trimming, line by line, where it
 * can see what it is dropping.
 */
export const TAIL_BYTES = 16_384;

export interface LogTail {
  /** False when there is nothing to read — and `reason` says which nothing. */
  available: boolean;
  reason: string;
  /** The tail itself, whole lines only. Empty when `available` is false. */
  text: string;
  /** True when the file was longer than `TAIL_BYTES` and the front was cut off. */
  truncated: boolean;
  /** `steward.log.old` exists, so there is more, and the reader now knows where. */
  hasOld: boolean;
  /** For the PAGE to show. It never goes in the body — it contains a home directory. */
  path: string | null;
}

const none = (reason: string, path: string | null = null): LogTail =>
  ({ available: false, reason, text: '', truncated: false, hasOld: false, path });

/**
 * The last `TAIL_BYTES` of the log, or a sentence saying why there is no log.
 *
 * From a checkout there is no file at all, and that is correct: `installFileLog` returns
 * null unless packaged, because a terminal is right there and a second copy of it is one
 * more thing to go stale. The report says so plainly rather than turning the log on to
 * make this feature tidier — that would invert 0010's reasoning to serve a form.
 */
export async function readLogTail(
  opts: { packaged: boolean; path?: string } = { packaged: false },
): Promise<LogTail> {
  if (!opts.packaged && !opts.path) {
    return none('This build runs from a checkout, which logs to the console rather than to a file.');
  }
  const path = opts.path ?? logFile();

  const file = Bun.file(path);
  if (!(await file.exists())) return none('No log file has been written yet.', path);

  const size = file.size;
  if (!size) return none('The log file is empty.', path);

  const truncated = size > TAIL_BYTES;
  const blob = truncated ? file.slice(size - TAIL_BYTES) : file;
  let text = await blob.text();

  // Slicing at a byte offset can cut a UTF-8 character in half, which yields a
  // replacement character at the front of the text. The fix is the thing we want anyway:
  // discard everything up to and including the first newline, because a half-line is
  // noise whatever its encoding. One rule, two problems.
  if (truncated) {
    const nl = text.indexOf('\n');
    text = nl >= 0 ? text.slice(nl + 1) : '';
  }

  const hasOld = await Bun.file(`${path}.old`).exists();
  return {
    available: text.trim().length > 0,
    reason: text.trim().length ? '' : 'The log file holds nothing readable.',
    text: text.replace(/\s+$/, ''),
    truncated,
    hasOld,
    path,
  };
}
