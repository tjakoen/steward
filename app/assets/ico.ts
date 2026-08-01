// Pack PNGs into a Windows .ico — `bun build --compile --windows-icon` needs one, and
// this repo had none.
//
// No dependency is warranted: an ICO is a 6-byte header, a 16-byte directory entry per
// image, and then the image bytes verbatim. Windows has accepted PNG payloads inside ICO
// since Vista, so nothing here has to encode a bitmap.

export interface IconImage {
  /** 16, 32, 48, 64, 128 or 256. Square — Windows shows the rest stretched. */
  size: number;
  png: Uint8Array;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

/** ICO stores 256 as 0 in a single byte; anything larger has no representation. */
const sizeByte = (size: number): number => {
  if (size < 1 || size > 256) throw new Error(`icon size out of range: ${size}`);
  return size === 256 ? 0 : size;
};

export function packIco(images: IconImage[]): Uint8Array {
  if (!images.length) throw new Error('an icon needs at least one image');
  for (const { png, size } of images) {
    if (!PNG_MAGIC.every((b, i) => png[i] === b)) {
      throw new Error(`the ${size}px image is not a PNG`);
    }
  }

  // Largest first: Explorer picks the first entry that fits, and a 16px lead entry is
  // what makes an application look blurry at every size above it.
  const sorted = [...images].sort((a, b) => b.size - a.size);

  const HEADER = 6, ENTRY = 16;
  const dataStart = HEADER + ENTRY * sorted.length;
  const total = dataStart + sorted.reduce((n, i) => n + i.png.length, 0);

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  view.setUint16(0, 0, true); // reserved
  view.setUint16(2, 1, true); // 1 = icon (2 would be a cursor)
  view.setUint16(4, sorted.length, true);

  let offset = dataStart;
  sorted.forEach((image, n) => {
    const at = HEADER + ENTRY * n;
    out[at] = sizeByte(image.size);
    out[at + 1] = sizeByte(image.size);
    out[at + 2] = 0; // palette size — 0 for truecolor
    out[at + 3] = 0; // reserved
    view.setUint16(at + 4, 1, true); // colour planes
    view.setUint16(at + 6, 32, true); // bits per pixel
    view.setUint32(at + 8, image.png.length, true);
    view.setUint32(at + 12, offset, true);
    out.set(image.png, offset);
    offset += image.png.length;
  });

  return out;
}

export interface IcoEntry { size: number; length: number; offset: number }

/** Read an .ico back — what the verification uses to prove the file is really one. */
export function readIco(bytes: Uint8Array): IcoEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) {
    throw new Error('not an icon file');
  }
  const count = view.getUint16(4, true);
  return Array.from({ length: count }, (_, n) => {
    const at = 6 + 16 * n;
    return {
      size: bytes[at] === 0 ? 256 : bytes[at],
      length: view.getUint32(at + 8, true),
      offset: view.getUint32(at + 12, true),
    };
  });
}
