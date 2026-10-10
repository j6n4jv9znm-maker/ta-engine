import { unzlibSync } from 'fflate';
import type { ByteSource } from '../io/byteSource';

/*
 * HPI archive reader. TA's .hpi, .ufo, .ccx, .gpf and .gp3 files all share this format.
 *
 * Layout (all integers little-endian), per the community HPI docs and RWE's reader:
 *   header:     "HAPI", version 0x00010000, directorySize, headerKey, start
 *   directory:  bytes [start, directorySize) of the file. Offsets inside it are absolute file offsets.
 *     dir:      numberOfEntries u32, entryListOffset u32
 *     entry:    nameOffset u32, dataOffset u32, isDirectory u8          (9 bytes)
 *     file:     dataOffset u32, fileSize u32, compression u8 (0 none, 1 LZ77, 2 zlib)
 *   compressed file data: one u32 size per 64 KiB chunk, then the chunks, each with a 19-byte
 *     header: "SQSH", version u8, compression u8, encrypted u8, compressedSize, decompressedSize, checksum.
 *
 * Everything after the 20-byte header is XOR-obfuscated with a key derived from headerKey and the
 * byte's absolute file position. Chunk payloads may also carry a second, position-in-chunk obfuscation.
 */

const HAPI = 0x49504148; // "HAPI"
const VERSION_TA = 0x00010000;
const BANK = 0x4b4e4142; // "BANK": saved games, not archives
const SQSH = 0x48535153; // "SQSH"
const CHUNK_SIZE = 65536;
const CHUNK_HEADER_SIZE = 19;

export type Compression = 'none' | 'lz77' | 'zlib';

export interface HpiFile {
  kind: 'file';
  name: string;
  /** Full path inside the archive, using "/" separators, original case (e.g. "units/ARMCOM.FBI"). */
  path: string;
  size: number;
  compression: Compression;
  /** Absolute offset of the file data (or its chunk-size table when compressed). */
  dataOffset: number;
}

export interface HpiDirectory {
  kind: 'dir';
  name: string;
  path: string;
  entries: HpiEntry[];
}

export type HpiEntry = HpiFile | HpiDirectory;

export class HpiError extends Error {}

/** Derives the per-archive XOR key. A key of 0 means the archive is not obfuscated. */
export function transformKey(headerKey: number): number {
  const k = headerKey & 0xff;
  return ((k << 2) | (k >> 6)) & 0xff;
}

/** Undoes the archive-wide obfuscation in place. `position` is the absolute file offset of buf[0]. */
export function decryptInPlace(key: number, position: number, buf: Uint8Array): void {
  if (key === 0) return;
  for (let i = 0; i < buf.length; i++) {
    buf[i] = buf[i]! ^ (((position + i) & 0xff) ^ key);
  }
}

/** TA's LZ77 variant: 4 KiB window starting at position 1, 8 flags per tag byte, 12-bit offset + 4-bit length. */
export function decompressLz77(input: Uint8Array, outSize: number): Uint8Array {
  const out = new Uint8Array(outSize);
  const window = new Uint8Array(4096);
  let inPos = 0;
  let outPos = 0;
  let windowPos = 1;

  for (;;) {
    if (inPos >= input.length) throw new HpiError('LZ77: unexpected end of input (tag)');
    let tag = input[inPos++]!;
    for (let bit = 0; bit < 8; bit++, tag >>= 1) {
      if ((tag & 1) === 0) {
        if (inPos >= input.length) throw new HpiError('LZ77: unexpected end of input (literal)');
        if (outPos >= outSize) throw new HpiError('LZ77: output overrun');
        const b = input[inPos++]!;
        out[outPos++] = b;
        window[windowPos] = b;
        windowPos = (windowPos + 1) & 0xfff;
      } else {
        if (inPos + 1 >= input.length) throw new HpiError('LZ77: unexpected end of input (match)');
        const packed = input[inPos]! | (input[inPos + 1]! << 8);
        inPos += 2;
        let offset = packed >> 4;
        if (offset === 0) {
          if (outPos !== outSize) throw new HpiError(`LZ77: produced ${outPos} bytes, expected ${outSize}`);
          return out;
        }
        const count = (packed & 0x0f) + 2;
        if (outPos + count > outSize) throw new HpiError('LZ77: output overrun');
        for (let i = 0; i < count; i++) {
          const b = window[offset]!;
          out[outPos++] = b;
          window[windowPos] = b;
          offset = (offset + 1) & 0xfff;
          windowPos = (windowPos + 1) & 0xfff;
        }
      }
    }
  }
}

export class HpiArchive {
  private constructor(
    readonly source: ByteSource,
    private readonly key: number,
    readonly root: HpiDirectory,
  ) {}

  get name(): string {
    return this.source.name;
  }

  static async open(source: ByteSource): Promise<HpiArchive> {
    if (source.size < 20) throw new HpiError(`${source.name}: too small to be an HPI archive`);
    const head = await source.read(0, 20);
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const marker = view.getUint32(0, true);
    const version = view.getUint32(4, true);
    if (marker !== HAPI) throw new HpiError(`${source.name}: not an HPI archive (no HAPI marker)`);
    if (version === BANK) throw new HpiError(`${source.name}: is a saved game, not an archive`);
    if (version !== VERSION_TA) {
      throw new HpiError(`${source.name}: unsupported HPI version 0x${version.toString(16)} (only TA's 0x10000)`);
    }
    const directorySize = view.getUint32(8, true);
    const key = transformKey(view.getUint32(12, true));
    const start = view.getUint32(16, true);
    if (start < 20 || directorySize <= start || directorySize > source.size) {
      throw new HpiError(`${source.name}: corrupt header (start ${start}, directorySize ${directorySize})`);
    }

    // Keep the directory at its absolute offsets so entry offsets index it directly.
    const dir = new Uint8Array(directorySize);
    const raw = await source.read(start, directorySize - start);
    dir.set(raw, start);
    decryptInPlace(key, start, dir.subarray(start));

    const root = parseDirectory(dir, start, '', '', source.name, 0);
    return new HpiArchive(source, key, root);
  }

  /** Every file in the archive, depth-first. */
  files(): HpiFile[] {
    const out: HpiFile[] = [];
    const walk = (d: HpiDirectory) => {
      for (const e of d.entries) {
        if (e.kind === 'dir') walk(e);
        else out.push(e);
      }
    };
    walk(this.root);
    return out;
  }

  /** Case-insensitive lookup by "/"-separated path. Returns undefined when missing. */
  find(path: string): HpiEntry | undefined {
    const parts = splitPath(path);
    let cur: HpiEntry = this.root;
    for (const part of parts) {
      if (cur.kind !== 'dir') return undefined;
      const lower = part.toLowerCase();
      const next: HpiEntry | undefined = cur.entries.find((e) => e.name.toLowerCase() === lower);
      if (!next) return undefined;
      cur = next;
    }
    return cur;
  }

  /** Reads and decompresses a file's contents. */
  async extract(file: HpiFile): Promise<Uint8Array> {
    if (file.compression === 'none') return this.readDecrypted(file.dataOffset, file.size);

    const chunkCount = Math.ceil(file.size / CHUNK_SIZE);
    if (chunkCount === 0) return new Uint8Array(0);
    const table = await this.readDecrypted(file.dataOffset, chunkCount * 4);
    const tableView = new DataView(table.buffer, table.byteOffset, table.byteLength);
    let total = 0;
    for (let i = 0; i < chunkCount; i++) total += tableView.getUint32(i * 4, true);

    const chunksStart = file.dataOffset + chunkCount * 4;
    const chunks = await this.readDecrypted(chunksStart, total);
    const out = new Uint8Array(file.size);
    let inPos = 0;
    let outPos = 0;
    for (let i = 0; i < chunkCount; i++) {
      const chunkLen = tableView.getUint32(i * 4, true);
      const chunk = chunks.subarray(inPos, inPos + chunkLen);
      inPos += chunkLen;
      const data = decodeChunk(chunk, `${this.name}:${file.path} chunk ${i}`);
      if (outPos + data.length > file.size) throw new HpiError(`${this.name}:${file.path}: larger than expected`);
      out.set(data, outPos);
      outPos += data.length;
    }
    if (outPos !== file.size) {
      throw new HpiError(`${this.name}:${file.path}: got ${outPos} bytes, expected ${file.size}`);
    }
    return out;
  }

  private async readDecrypted(offset: number, length: number): Promise<Uint8Array> {
    // Copy so we never mutate a source's backing buffer (MemorySource returns a view).
    const buf = new Uint8Array(await this.source.read(offset, length));
    decryptInPlace(this.key, offset, buf);
    return buf;
  }
}

function decodeChunk(chunk: Uint8Array, where: string): Uint8Array {
  if (chunk.length < CHUNK_HEADER_SIZE) throw new HpiError(`${where}: truncated chunk header`);
  const v = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (v.getUint32(0, true) !== SQSH) throw new HpiError(`${where}: bad chunk marker`);
  const compression = chunk[5]!;
  const encrypted = chunk[6]! !== 0;
  const compressedSize = v.getUint32(7, true);
  const decompressedSize = v.getUint32(11, true);
  const checksum = v.getUint32(15, true);
  if (CHUNK_HEADER_SIZE + compressedSize > chunk.length) throw new HpiError(`${where}: truncated chunk data`);

  const data = chunk.slice(CHUNK_HEADER_SIZE, CHUNK_HEADER_SIZE + compressedSize);
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum = (sum + data[i]!) >>> 0;
  if (sum !== checksum) throw new HpiError(`${where}: checksum mismatch`);

  if (encrypted) {
    for (let i = 0; i < data.length; i++) {
      const p = i & 0xff;
      data[i] = ((data[i]! - p) & 0xff) ^ p;
    }
  }

  switch (compression) {
    case 0:
      if (compressedSize !== decompressedSize) throw new HpiError(`${where}: stored chunk size mismatch`);
      return data;
    case 1:
      return decompressLz77(data, decompressedSize);
    case 2: {
      const out = unzlibSync(data, { out: new Uint8Array(decompressedSize) });
      if (out.length !== decompressedSize) throw new HpiError(`${where}: zlib size mismatch`);
      return out;
    }
    default:
      throw new HpiError(`${where}: unknown chunk compression ${compression}`);
  }
}

const MAX_DEPTH = 64;

function parseDirectory(
  dir: Uint8Array,
  offset: number,
  name: string,
  path: string,
  archive: string,
  depth: number,
): HpiDirectory {
  if (depth > MAX_DEPTH) throw new HpiError(`${archive}: directory tree too deep (corrupt?)`);
  const view = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  if (offset + 8 > dir.length) throw new HpiError(`${archive}: directory header out of range`);
  const count = view.getUint32(offset, true);
  const listOffset = view.getUint32(offset + 4, true);
  if (listOffset + count * 9 > dir.length) throw new HpiError(`${archive}: directory entries out of range`);

  const entries: HpiEntry[] = [];
  for (let i = 0; i < count; i++) {
    const e = listOffset + i * 9;
    const entryName = readCString(dir, view.getUint32(e, true), archive);
    const dataOffset = view.getUint32(e + 4, true);
    const isDir = dir[e + 8]! !== 0;
    const entryPath = path ? `${path}/${entryName}` : entryName;
    if (isDir) {
      entries.push(parseDirectory(dir, dataOffset, entryName, entryPath, archive, depth + 1));
    } else {
      if (dataOffset + 9 > dir.length) throw new HpiError(`${archive}: file record out of range`);
      const c = dir[dataOffset + 8]!;
      entries.push({
        kind: 'file',
        name: entryName,
        path: entryPath,
        dataOffset: view.getUint32(dataOffset, true),
        size: view.getUint32(dataOffset + 4, true),
        compression: c === 0 ? 'none' : c === 1 ? 'lz77' : 'zlib',
      });
    }
  }
  return { kind: 'dir', name, path, entries };
}

function readCString(buf: Uint8Array, offset: number, archive: string): string {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  if (end >= buf.length) throw new HpiError(`${archive}: unterminated name`);
  return latin1(buf.subarray(offset, end));
}

/** TA text is Windows-1252/Latin-1. Decoding as latin1 keeps every byte as one character. */
export function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return s;
}

export function splitPath(path: string): string[] {
  return path.split(/[/\\]+/).filter((p) => p.length > 0);
}
