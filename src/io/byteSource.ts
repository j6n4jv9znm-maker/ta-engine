/**
 * Random-access, read-only bytes. Archives are large (up to ~150 MB), so readers pull only the
 * ranges they need instead of loading whole files. Node reads from disk; the browser reads from a File.
 */
export interface ByteSource {
  /** Display name, usually the file name (e.g. "totala1.hpi"). */
  readonly name: string;
  readonly size: number;
  /** Reads `length` bytes starting at `offset`. Throws if the range runs past the end. */
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** A ByteSource over bytes already in memory. Handy for tests. */
export class MemorySource implements ByteSource {
  constructor(
    readonly name: string,
    private readonly bytes: Uint8Array,
  ) {}

  get size(): number {
    return this.bytes.length;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    checkRange(this, offset, length);
    return this.bytes.subarray(offset, offset + length);
  }
}

/** A ByteSource over a browser Blob or File. */
export class BlobSource implements ByteSource {
  constructor(
    readonly name: string,
    private readonly blob: Blob,
  ) {}

  get size(): number {
    return this.blob.size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    checkRange(this, offset, length);
    return new Uint8Array(await this.blob.slice(offset, offset + length).arrayBuffer());
  }
}

export function checkRange(source: ByteSource, offset: number, length: number): void {
  if (offset < 0 || length < 0 || offset + length > source.size) {
    throw new RangeError(`${source.name}: read of ${length} bytes at ${offset} runs past end (${source.size} bytes)`);
  }
}
