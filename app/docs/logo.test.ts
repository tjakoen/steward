import { test, expect } from 'bun:test';
import { MAX_BYTES, validateLogo } from './logo.ts';

const png = (size = 32) => {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return b;
};
const jpeg = (size = 32) => {
  const b = new Uint8Array(size);
  b.set([0xff, 0xd8, 0xff]);
  return b;
};

test('a PNG becomes a data URL with the type the BYTES say', () => {
  const r = validateLogo(png());
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.mimeType).toBe('image/png');
  expect(r.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
});

test('a JPEG is accepted too', () => {
  const r = validateLogo(jpeg());
  expect(r.ok && r.mimeType).toBe('image/jpeg');
});

// A print pipeline is a poor place to relax about a script-bearing format.
test('SVG is refused, whatever the upload claimed to be', () => {
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>');
  const r = validateLogo(svg);
  expect(r.ok).toBe(false);
  expect(r.ok === false && r.error).toContain('PNG or a JPEG');
});

test('a renamed .png that is really something else is refused', () => {
  expect(validateLogo(new TextEncoder().encode('MZ\x90\x00 not an image')).ok).toBe(false);
});

test('an oversized logo is refused, and the message says why it matters', () => {
  const r = validateLogo(png(MAX_BYTES + 1));
  expect(r.ok).toBe(false);
  expect(r.ok === false && r.error).toContain('every document');
});

test('exactly at the cap is still allowed', () => {
  expect(validateLogo(png(MAX_BYTES)).ok).toBe(true);
});

test('an empty file is refused before anything is sniffed', () => {
  expect(validateLogo(new Uint8Array(0)).ok).toBe(false);
});
