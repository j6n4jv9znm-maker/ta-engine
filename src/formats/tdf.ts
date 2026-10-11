/*
 * Parser for TA's bracketed text format, used by .tdf, .fbi, .ota, .gui and friends:
 *
 *   [UNITINFO]
 *   {
 *     UnitName=ARMCOM;     // line comments
 *     [SUBBLOCK] { key=value; }   /* block comments *\/
 *   }
 *
 * TA treats names case-insensitively, so block and property names are lowercased. Values keep their
 * original text (trimmed). A repeated key keeps the last value.
 *
 * Grammar follows RWE's TdfParser (src/rwe/io/tdf/TdfParser.h) but is more forgiving, because real
 * files contain mistakes the original game tolerates. Recoverable problems are collected as warnings
 * instead of failing the whole file:
 *   - a property missing its ';' ends at the end of the line
 *   - stray ';' between statements is ignored
 *   - a line with no '=' is skipped
 *   - a missing closing '}' at end of file closes the open blocks
 */

export interface TdfBlock {
  [key: string]: string | TdfBlock;
}

export interface TdfWarning {
  line: number;
  message: string;
}

export interface TdfOptions {
  /**
   * Keep blocks whose name repeats, renamed "name#2", "name#3", ... (normally the last one wins).
   * Some GUI files reuse gadget numbers, and every gadget matters there.
   */
  keepDuplicateBlocks?: boolean;
}

export interface TdfResult {
  root: TdfBlock;
  warnings: TdfWarning[];
}

export class TdfError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(`line ${line}: ${message}`);
  }
}

/** Parses TDF text. Returns the top-level blocks plus any recoverable problems found. */
export function parseTdfWithWarnings(text: string, options: TdfOptions = {}): TdfResult {
  return new Parser(stripComments(text), options.keepDuplicateBlocks ?? false).parse();
}

/** Parses TDF text, ignoring recoverable problems. */
export function parseTdf(text: string, options: TdfOptions = {}): TdfBlock {
  return parseTdfWithWarnings(text, options).root;
}

/** Case-insensitive lookup of a nested block, e.g. getBlock(fbi, 'UNITINFO'). */
export function getBlock(block: TdfBlock, name: string): TdfBlock | undefined {
  const v = block[name.toLowerCase()];
  return typeof v === 'object' ? v : undefined;
}

/** Case-insensitive lookup of a property value. */
export function getValue(block: TdfBlock, name: string): string | undefined {
  const v = block[name.toLowerCase()];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Replaces comments with spaces (keeping newlines so line numbers stay right). Comment markers inside
 * values count as comments too, matching RWE. An unterminated block comment runs to end of file.
 */
function stripComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : ' ';
        i++;
      }
      i += 2;
      out += '  ';
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/\r\n?/g, '\n');
}

class Parser {
  private pos = 0;
  private line = 1;
  private readonly warnings: TdfWarning[] = [];

  constructor(
    private readonly s: string,
    private readonly keepDuplicates: boolean,
  ) {}

  private put(target: TdfBlock, name: string, block: TdfBlock): void {
    let key = name;
    if (this.keepDuplicates) for (let n = 2; key in target; n++) key = `${name}#${n}`;
    target[key] = block;
  }

  parse(): TdfResult {
    const root: TdfBlock = {};
    for (;;) {
      this.skipSpaceAndSemicolons();
      if (this.eof()) break;
      if (this.peek() === '[') {
        const [name, block] = this.block();
        this.put(root, name, block);
      } else if (this.peek() === '}') {
        this.warn('unexpected "}" at top level');
        this.advance();
      } else {
        // Junk before or between top-level blocks: skip the line.
        this.warn('text outside any block skipped');
        this.skipLine();
      }
    }
    return { root, warnings: this.warnings };
  }

  private block(): [string, TdfBlock] {
    this.expect('[');
    const name = this.readUntil(']', 'block name').trim().toLowerCase();
    this.expect(']');
    this.skipSpace();
    if (this.peek() !== '{') throw new TdfError(this.line, `expected "{" after [${name}]`);
    this.advance();

    const block: TdfBlock = {};
    for (;;) {
      this.skipSpaceAndSemicolons();
      if (this.eof()) {
        this.warn(`end of file inside [${name}]; closing it`);
        return [name, block];
      }
      const c = this.peek();
      if (c === '}') {
        this.advance();
        return [name, block];
      }
      if (c === '[') {
        const [childName, child] = this.block();
        this.put(block, childName, child);
        continue;
      }
      this.property(block);
    }
  }

  private property(block: TdfBlock): void {
    const startLine = this.line;
    let key = '';
    while (!this.eof()) {
      const c = this.peek();
      if (c === '=' || c === ';' || c === '\n' || c === '}' || c === '[') break;
      key += c;
      this.advance();
    }
    key = key.trim().toLowerCase();
    if (this.peek() !== '=') {
      this.warn(`line without "=" skipped: "${key.slice(0, 40)}"`, startLine);
      if (this.peek() === ';' || this.peek() === '\n') this.advance();
      return;
    }
    this.advance(); // '='

    let value = '';
    while (!this.eof()) {
      const c = this.peek();
      if (c === ';' || c === '\n' || c === '}') break;
      value += c;
      this.advance();
    }
    if (this.peek() === ';') {
      this.advance();
    } else {
      this.warn(`missing ";" after ${key}`, startLine);
    }
    if (key.length === 0) {
      this.warn('property with empty name skipped', startLine);
      return;
    }
    block[key] = value.trim();
  }

  private readUntil(ch: string, what: string): string {
    let out = '';
    while (!this.eof() && this.peek() !== ch) {
      if (this.peek() === '\n') throw new TdfError(this.line, `unterminated ${what}`);
      out += this.peek();
      this.advance();
    }
    return out;
  }

  private expect(ch: string): void {
    if (this.peek() !== ch) throw new TdfError(this.line, `expected "${ch}"`);
    this.advance();
  }

  private skipSpace(): void {
    while (!this.eof() && /\s/.test(this.peek())) this.advance();
  }

  private skipSpaceAndSemicolons(): void {
    while (!this.eof() && (/\s/.test(this.peek()) || this.peek() === ';' || this.peek() === '\0')) this.advance();
  }

  private skipLine(): void {
    while (!this.eof() && this.peek() !== '\n') this.advance();
  }

  private peek(): string {
    return this.s[this.pos] ?? '';
  }

  private advance(): void {
    if (this.s[this.pos] === '\n') this.line++;
    this.pos++;
  }

  private eof(): boolean {
    return this.pos >= this.s.length;
  }

  private warn(message: string, line = this.line): void {
    this.warnings.push({ line, message });
  }
}
