import { zlibSync } from 'fflate';

/*
 * Builds small synthetic HPI archives for tests, so the reader is covered even without game data.
 * Writes the format exactly as documented in src/formats/hpi.ts.
 */

export interface TestFile {
  path: string; // e.g. "units/ARMCOM.FBI"
  data: Uint8Array;
  /** How to store it: 0 stored, 1 LZ77 (literals only plus an optional repeat), 2 zlib. */
  compression: 0 | 1 | 2;
  /** Set the per-chunk obfuscation flag. */
  encryptChunks?: boolean;
}

export function buildHpi(files: TestFile[], headerKey = 0x7d): Uint8Array {
  // Directory tree from the paths.
  interface Dir {
    dirs: Map<string, Dir>;
    files: TestFile[];
  }
  const root: Dir = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let d = root;
    for (const p of parts.slice(0, -1)) {
      if (!d.dirs.has(p)) d.dirs.set(p, { dirs: new Map(), files: [] });
      d = d.dirs.get(p)!;
    }
    d.files.push({ ...f, path: parts[parts.length - 1]! });
  }

  const out: number[] = new Array(20).fill(0);
  const u32 = (at: number, v: number) => {
    out[at] = v & 0xff;
    out[at + 1] = (v >>> 8) & 0xff;
    out[at + 2] = (v >>> 16) & 0xff;
    out[at + 3] = (v >>> 24) & 0xff;
  };
  const alloc = (n: number) => {
    const at = out.length;
    for (let i = 0; i < n; i++) out.push(0);
    return at;
  };
  const cstr = (s: string) => {
    const at = out.length;
    for (const c of s) out.push(c.charCodeAt(0));
    out.push(0);
    return at;
  };

  // Directory region: written first, file records point at data appended afterwards.
  const start = 20;
  const pendingData: { recordAt: number; file: TestFile }[] = [];
  const writeDir = (d: Dir): number => {
    const headerAt = alloc(8);
    const entries = [...d.dirs.entries()].map(([name, sub]) => ({ name, sub })) as {
      name: string;
      sub?: Dir;
      file?: TestFile;
    }[];
    entries.push(...d.files.map((f) => ({ name: f.path, file: f })));
    const listAt = alloc(entries.length * 9);
    u32(headerAt, entries.length);
    u32(headerAt + 4, listAt);
    entries.forEach((e, i) => {
      const at = listAt + i * 9;
      u32(at, cstr(e.name));
      if (e.sub) {
        u32(at + 4, writeDir(e.sub));
        out[at + 8] = 1;
      } else {
        const rec = alloc(9);
        u32(at + 4, rec);
        out[at + 8] = 0;
        pendingData.push({ recordAt: rec, file: e.file! });
      }
    });
    return headerAt;
  };
  writeDir(root);
  const directorySize = out.length;

  for (const { recordAt, file } of pendingData) {
    const dataAt = out.length;
    u32(recordAt, dataAt);
    u32(recordAt + 4, file.data.length);
    out[recordAt + 8] = file.compression;
    if (file.compression === 0) {
      out.push(...file.data);
      continue;
    }
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < Math.max(1, Math.ceil(file.data.length / 65536)); i++) {
      chunks.push(file.data.subarray(i * 65536, (i + 1) * 65536));
    }
    const encoded = chunks.map((c) => encodeChunk(c, file.compression as 1 | 2, file.encryptChunks ?? false));
    for (const e of encoded) {
      const at = alloc(4);
      u32(at, e.length);
    }
    for (const e of encoded) out.push(...e);
  }

  // Header: "HAPI", version, directorySize, headerKey, start.
  u32(0, 0x49504148);
  u32(4, 0x00010000);
  u32(8, directorySize);
  u32(12, headerKey);
  u32(16, start);

  const bytes = Uint8Array.from(out);
  const key = (((headerKey & 0xff) << 2) | ((headerKey & 0xff) >> 6)) & 0xff;
  if (key !== 0) for (let i = 20; i < bytes.length; i++) bytes[i] = bytes[i]! ^ ((i & 0xff) ^ key);
  return bytes;
}

function encodeChunk(data: Uint8Array, compression: 1 | 2, encrypt: boolean): Uint8Array {
  const payload = compression === 2 ? zlibSync(data) : lz77LiteralsOnly(data);
  if (encrypt) {
    for (let i = 0; i < payload.length; i++) {
      const p = i & 0xff;
      payload[i] = ((payload[i]! ^ p) + p) & 0xff;
    }
  }
  let sum = 0;
  for (const b of payload) sum = (sum + b) >>> 0;
  const header = new Uint8Array(19);
  const v = new DataView(header.buffer);
  v.setUint32(0, 0x48535153, true);
  header[4] = 2;
  header[5] = compression;
  header[6] = encrypt ? 1 : 0;
  v.setUint32(7, payload.length, true);
  v.setUint32(11, data.length, true);
  v.setUint32(15, sum, true);
  const out = new Uint8Array(19 + payload.length);
  out.set(header);
  out.set(payload, 19);
  return out;
}

/** Encodes as TA LZ77 using only literals, then the end marker. Valid, just not compressed. */
export function lz77LiteralsOnly(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  for (;;) {
    const tagAt = out.length;
    out.push(0);
    let tag = 0;
    for (let bit = 0; bit < 8; bit++) {
      if (i < data.length) {
        out.push(data[i++]!);
      } else {
        tag |= 1 << bit;
        out.push(0, 0); // offset 0 = end of stream
        out[tagAt] = tag;
        return Uint8Array.from(out);
      }
    }
    out[tagAt] = tag;
  }
}
