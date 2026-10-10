import { latin1 } from './hpi';

/*
 * COB: compiled unit scripts (scripts/<unit>.cob). Layout per the community docs and RWE
 * (src/rwe/io/cob), little-endian. Header (44 bytes):
 *
 *   version u32, scriptCount u32, pieceCount u32, codeLength u32 (in 32-bit words), staticCount u32,
 *   unknown u32, scriptAddressesOffset u32, scriptNameOffsetsOffset u32, pieceNameOffsetsOffset u32,
 *   codeOffset u32, unknown u32
 *
 * Script addresses are word indices into the code. Names are null-terminated strings at the given offsets.
 */

export interface CobFunction {
  name: string;
  /** Word index of the function's first instruction. */
  address: number;
}

export interface CobScript {
  /** Bytecode as 32-bit words. */
  code: Uint32Array;
  functions: CobFunction[];
  /** Piece names, indexed by the piece numbers used in the code. */
  pieces: string[];
  staticCount: number;
}

export class CobError extends Error {}

export function parseCob(bytes: Uint8Array): CobScript {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const check = (at: number, len: number) => {
    if (at < 0 || at + len > bytes.length) throw new CobError(`read of ${len} bytes at ${at} out of range`);
  };
  check(0, 44);
  const u32 = (at: number) => {
    check(at, 4);
    return v.getUint32(at, true);
  };
  const cstr = (at: number) => {
    let end = at;
    while (end < bytes.length && bytes[end] !== 0) end++;
    if (end >= bytes.length) throw new CobError('unterminated name');
    return latin1(bytes.subarray(at, end));
  };

  const scriptCount = u32(4);
  const pieceCount = u32(8);
  const codeLength = u32(12);
  const staticCount = u32(16);
  const addressesAt = u32(24);
  const namesAt = u32(28);
  const piecesAt = u32(32);
  const codeAt = u32(36);
  if (scriptCount > 10000 || pieceCount > 10000) throw new CobError('implausible header (not a COB file?)');

  check(codeAt, codeLength * 4);
  const code = new Uint32Array(codeLength);
  for (let i = 0; i < codeLength; i++) code[i] = v.getUint32(codeAt + i * 4, true);

  const functions: CobFunction[] = [];
  for (let i = 0; i < scriptCount; i++) {
    const address = u32(addressesAt + i * 4);
    if (address >= codeLength) throw new CobError(`script ${i} starts outside the code`);
    functions.push({ name: cstr(u32(namesAt + i * 4)), address });
  }
  const pieces: string[] = [];
  for (let i = 0; i < pieceCount; i++) pieces.push(cstr(u32(piecesAt + i * 4)));

  return { code, functions, pieces, staticCount };
}
