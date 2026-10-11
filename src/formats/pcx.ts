/*
 * PCX images (ZSoft), as used for TA's build-menu unit pictures (unitpics/*.pcx).
 * Layout: 128-byte header (manufacturer 0x0A, version, encoding 1 = RLE, bitsPerPixel,
 * xMin,yMin,xMax,yMax u16, ..., planes u8 at 65, bytesPerLine u16 at 66), then RLE scanlines
 * (a byte with the top two bits set is a run count in its low six bits, followed by the value),
 * then for 8-bit images a 0x0C marker and a 256-colour RGB palette at the end of the file.
 * We decode 8-bit single-plane and 24-bit (3-plane) images to RGBA.
 */

export class PcxError extends Error {}

export interface PcxImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export function parsePcx(bytes: Uint8Array): PcxImage {
  if (bytes.length < 128 || bytes[0] !== 0x0a) throw new PcxError('Not a PCX file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const encoding = bytes[2]!;
  const bpp = bytes[3]!;
  const xMin = view.getUint16(4, true);
  const yMin = view.getUint16(6, true);
  const xMax = view.getUint16(8, true);
  const yMax = view.getUint16(10, true);
  const planes = bytes[65]!;
  const bytesPerLine = view.getUint16(66, true);
  const width = xMax - xMin + 1;
  const height = yMax - yMin + 1;
  if (bpp !== 8 || (planes !== 1 && planes !== 3)) throw new PcxError(`Unsupported PCX: ${bpp} bits, ${planes} planes`);
  if (width <= 0 || height <= 0 || width > 4096 || height > 4096) throw new PcxError('Bad PCX size');

  // Decode every scanline (all planes) into one buffer.
  const lineLen = bytesPerLine * planes;
  const raw = new Uint8Array(lineLen * height);
  let src = 128;
  let dst = 0;
  while (dst < raw.length && src < bytes.length) {
    const b = bytes[src++]!;
    if (encoding === 1 && (b & 0xc0) === 0xc0) {
      const count = b & 0x3f;
      const v = bytes[src++] ?? 0;
      raw.fill(v, dst, Math.min(raw.length, dst + count));
      dst += count;
    } else {
      raw[dst++] = b;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  if (planes === 1) {
    const palStart = bytes.length - 768;
    if (palStart < 128 || bytes[palStart - 1] !== 0x0c) throw new PcxError('PCX has no 256-colour palette');
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = raw[y * lineLen + x]! * 3 + palStart;
        rgba.set([bytes[i]!, bytes[i + 1]!, bytes[i + 2]!, 255], (y * width + x) * 4);
      }
    }
  } else {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = y * lineLen + x;
        rgba.set([raw[o]!, raw[o + bytesPerLine]!, raw[o + 2 * bytesPerLine]!, 255], (y * width + x) * 4);
      }
    }
  }
  return { width, height, rgba };
}
