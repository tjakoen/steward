// Validating a client logo (0013).
//
// A logo is bytes, and the JSON `/intent` door does not take bytes — the same wall
// 0006 hit, which is why uploads have their own multipart route. So this value
// arrives through `POST /clients/:id/logo`, is validated HERE rather than in the
// browser, and is written through `updateClient` so the change is audited like any
// other.
//
// It earns real validation because it is inlined into EVERY document the client ever
// generates and into their row in SQLite.

/** Base64 inflates by a third, and this value is carried by every PDF. */
export const MAX_BYTES = 512 * 1024;

/** What the document caps display at (`.logo` in app/view/doc.ts). */
export const DISPLAY_SIZE = { width: 220, height: 56 };

export type LogoResult =
  | { ok: true; dataUrl: string; mimeType: 'image/png' | 'image/jpeg'; bytes: number }
  | { ok: false; error: string };

const startsWith = (bytes: Uint8Array, sig: number[]): boolean =>
  sig.every((b, i) => bytes[i] === b);

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];

/**
 * PNG and JPEG only, by what the bytes ACTUALLY are.
 *
 * SVG is refused on purpose: an SVG in an `<img>` is a script-bearing format, a print
 * pipeline is a poor place to relax about that, and no operator needs it. The declared
 * MIME type is not consulted at all — a browser will say whatever the file extension
 * suggested, and the whole point of checking is not to take the client's word for it.
 */
export function validateLogo(bytes: Uint8Array): LogoResult {
  if (!bytes.length) return { ok: false, error: 'That file is empty.' };
  if (bytes.length > MAX_BYTES) {
    return { ok: false,
      error: `That logo is ${Math.round(bytes.length / 1024)} KB. The limit is ${MAX_BYTES / 1024} KB, because this image is embedded in every document the client generates.` };
  }
  const mimeType = startsWith(bytes, PNG) ? 'image/png'
    : startsWith(bytes, JPEG) ? 'image/jpeg'
      : null;
  if (!mimeType) return { ok: false, error: 'A logo has to be a PNG or a JPEG.' };

  return {
    ok: true,
    mimeType,
    bytes: bytes.length,
    dataUrl: `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`,
  };
}
