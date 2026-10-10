/*
 * Command-line tool for poking at TA game data.  Run with:  npm run ta -- <command> [args]
 *
 *   archives                 list archives in load order (later ones win)
 *   ls [prefix]              list files, e.g. "ls units/"
 *   extract <path> [outDir]  write one file (default outDir: extracted/, which is gitignored)
 *   extract-all [outDir]     write every file
 *   cat <path>               print a text file
 *   tdf <path>               print any TDF/FBI/OTA/GUI file as JSON
 *   fbi <UNIT>               print a unit's FBI as JSON, e.g. "fbi ARMCOM"
 *   units                    list every unit with its name and description
 *   palette                  print the 256 palette colours
 *
 * Options: --data <dir>  folder holding the archives (default: data/)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { latin1 } from '../src/formats/hpi';
import { parsePalette, PALETTE_PATH } from '../src/formats/palette';
import { getBlock, getValue, parseTdfWithWarnings } from '../src/formats/tdf';
import { openDataDir } from '../src/io/nodeVfs';
import { DATA_DIR } from '../src/testData';
import { listUnitFiles, loadUnitFbi } from '../src/units';
import { normalize, type Vfs } from '../src/vfs';

const USAGE = `usage: npm run ta -- <command> [args] [--data <dir>]
commands: archives | ls [prefix] | extract <path> [outDir] | extract-all [outDir]
          cat <path> | tdf <path> | fbi <UNIT> | units | palette`;

async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  let dataDir = DATA_DIR;
  const di = args.indexOf('--data');
  if (di >= 0) {
    dataDir = resolve(args[di + 1] ?? '.');
    args.splice(di, 2);
  }
  const [cmd, ...rest] = args;
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }

  const { vfs, close } = await openDataDir(dataDir);
  try {
    return await run(vfs, cmd, rest);
  } finally {
    await close();
  }
}

async function run(vfs: Vfs, cmd: string, rest: string[]): Promise<number> {
  switch (cmd) {
    case 'archives': {
      vfs.archives.forEach((a, i) => console.log(`${String(i + 1).padStart(2)}. ${a.name}  (${a.files().length} files)`));
      console.log(`${vfs.fileCount} unique files after layering`);
      return 0;
    }
    case 'ls': {
      const prefix = rest[0] ? normalize(rest[0]) : '';
      const files = vfs.list().filter((f) => f.path.toLowerCase().startsWith(prefix));
      for (const f of files) {
        const over = f.overrides.length ? `  (overrides ${f.overrides.join(', ')})` : '';
        console.log(`${f.path}\t${f.size}\t${f.archive.name}${over}`);
      }
      console.log(`${files.length} files`);
      return 0;
    }
    case 'extract': {
      const path = need(rest[0], 'extract <path> [outDir]');
      const f = vfs.stat(path);
      if (!f) return notFound(path);
      const out = join(resolve(rest[1] ?? 'extracted'), f.path);
      write(out, await vfs.read(path));
      console.log(`wrote ${out} (${f.size} bytes, from ${f.archive.name})`);
      return 0;
    }
    case 'extract-all': {
      const root = resolve(rest[0] ?? 'extracted');
      const files = vfs.list();
      for (const f of files) write(join(root, f.path), await vfs.read(f.path));
      console.log(`wrote ${files.length} files to ${root}`);
      return 0;
    }
    case 'cat': {
      const path = need(rest[0], 'cat <path>');
      if (!vfs.exists(path)) return notFound(path);
      process.stdout.write(latin1(await vfs.read(path)));
      return 0;
    }
    case 'tdf': {
      const path = need(rest[0], 'tdf <path>');
      if (!vfs.exists(path)) return notFound(path);
      const { root, warnings } = parseTdfWithWarnings(latin1(await vfs.read(path)));
      for (const w of warnings) console.error(`warning: line ${w.line}: ${w.message}`);
      console.log(JSON.stringify(root, null, 2));
      return 0;
    }
    case 'fbi': {
      const name = need(rest[0], 'fbi <UNIT>');
      const unit = await loadUnitFbi(vfs, name);
      if (!unit) return notFound(`unit ${name}`);
      console.error(`// ${unit.path} (${vfs.stat(unit.path)!.archive.name})`);
      console.log(JSON.stringify(unit.fbi, null, 2));
      return 0;
    }
    case 'units': {
      for (const path of listUnitFiles(vfs)) {
        const info = getBlock(parseTdfWithWarnings(latin1(await vfs.read(path))).root, 'UNITINFO') ?? {};
        console.log(`${getValue(info, 'UnitName') ?? '?'}\t${getValue(info, 'Name') ?? ''}\t${getValue(info, 'Description') ?? ''}`);
      }
      return 0;
    }
    case 'palette': {
      const pal = parsePalette(await vfs.read(PALETTE_PATH));
      for (let i = 0; i < 256; i++) {
        const { r, g, b } = pal.color(i);
        console.log(`${String(i).padStart(3)}  ${pal.hex(i)}  ${r},${g},${b}`);
      }
      return 0;
    }
    default:
      console.error(`unknown command: ${cmd}\n${USAGE}`);
      return 1;
  }
}

function need(value: string | undefined, usage: string): string {
  if (!value) throw new Error(`usage: ${usage}`);
  return value;
}

function notFound(what: string): number {
  console.error(`not found: ${what}`);
  return 1;
}

function write(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

// Piping into `head` closes stdout early; that's fine, just stop.
process.stdout.on('error', (e: NodeJS.ErrnoException) => process.exit(e.code === 'EPIPE' ? 0 : 1));

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
