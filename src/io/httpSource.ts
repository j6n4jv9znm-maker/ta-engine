import { checkRange, type ByteSource } from './byteSource';

/** A ByteSource over HTTP using Range requests (used by the debug pages to read data/ via the dev server). */
export class HttpRangeSource implements ByteSource {
  constructor(
    readonly name: string,
    readonly size: number,
    private readonly url: string,
  ) {}

  async read(offset: number, length: number): Promise<Uint8Array> {
    checkRange(this, offset, length);
    if (length === 0) return new Uint8Array(0);
    const res = await fetch(this.url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    if (res.status !== 206) throw new Error(`${this.name}: server ignored range request (HTTP ${res.status})`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length !== length) throw new Error(`${this.name}: expected ${length} bytes, got ${buf.length}`);
    return buf;
  }
}
