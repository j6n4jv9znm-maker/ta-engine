import { open, type FileHandle } from 'node:fs/promises';
import { basename } from 'node:path';
import { checkRange, type ByteSource } from './byteSource';

/** A ByteSource reading from a file on disk (Node only: CLI and tests). */
export class NodeFileSource implements ByteSource {
  private constructor(
    readonly name: string,
    readonly size: number,
    private readonly handle: FileHandle,
  ) {}

  static async open(path: string): Promise<NodeFileSource> {
    const handle = await open(path, 'r');
    const { size } = await handle.stat();
    return new NodeFileSource(basename(path), size, handle);
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    checkRange(this, offset, length);
    const buf = new Uint8Array(length);
    let done = 0;
    while (done < length) {
      const { bytesRead } = await this.handle.read(buf, done, length - done, offset + done);
      if (bytesRead === 0) throw new Error(`${this.name}: unexpected end of file`);
      done += bytesRead;
    }
    return buf;
  }

  close(): Promise<void> {
    return this.handle.close();
  }
}
