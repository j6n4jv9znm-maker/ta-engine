/*
 * Gives your local build of the Mac app the original game's look: makes an icon from the Total
 * Annihilation logo in your own game files (bitmaps/Frontend1F.pcx) and puts it into the built app.
 * The logo is Cavedog's art, so it is only ever made on your machine from your data and never
 * committed. Uses macOS's sips and iconutil.
 *
 *   npm run app:icon [path/to/TA Engine.app ...]
 * With no paths it updates the freshly built app and ~/Applications/TA Engine.app if they exist.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { parsePcx } from '../src/formats/pcx';
import { openDataDir } from '../src/io/nodeVfs';
import { DATA_DIR } from '../src/testData';

const SIZE = 1024;
/** Where the logo sits in the 640x480 title screen. */
const LOGO = { x: 66, y: 24, w: 524, h: 300 };

const { vfs, close } = await openDataDir(DATA_DIR);
const path = vfs.listDir('bitmaps', '.pcx').find((f) => /frontend1f\.pcx$/i.test(f.path))?.path;
if (!path) throw new Error('No bitmaps/Frontend1F.pcx in your game files.');
const title = parsePcx(await vfs.read(path));
await close();

// A dark rounded square with the logo scaled to fit across it.
const out = new Uint8Array(SIZE * SIZE * 4);
const margin = 72;
const radius = 180;
const scale = (SIZE - 2 * margin - 40) / LOGO.w;
const logoH = LOGO.h * scale;
const top = (SIZE - logoH) / 2;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;
    const dx = Math.max(margin + radius - x, x - (SIZE - margin - radius), 0);
    const dy = Math.max(margin + radius - y, y - (SIZE - margin - radius), 0);
    if (Math.hypot(dx, dy) > radius) continue; // outside the rounded square: transparent
    let [r, g, b] = [18, 16, 12];
    const sx = Math.floor((x - (SIZE - LOGO.w * scale) / 2) / scale);
    const sy = Math.floor((y - top) / scale);
    if (sx >= 0 && sx < LOGO.w && sy >= 0 && sy < LOGO.h) {
      const j = ((LOGO.y + sy) * title.width + LOGO.x + sx) * 4;
      [r, g, b] = [title.rgba[j]!, title.rgba[j + 1]!, title.rgba[j + 2]!];
    }
    out.set([r, g, b, 255], i);
  }
}

const work = mkdtempSync(join(tmpdir(), 'ta-icon-'));
const base = join(work, 'icon.png');
writeFileSync(base, png(SIZE, SIZE, out));
const set = join(work, 'icon.iconset');
mkdirSync(set);
for (const s of [16, 32, 128, 256, 512]) {
  execFileSync('sips', ['-z', String(s), String(s), base, '--out', join(set, `icon_${s}x${s}.png`)], { stdio: 'ignore' });
  execFileSync('sips', ['-z', String(s * 2), String(s * 2), base, '--out', join(set, `icon_${s}x${s}@2x.png`)], { stdio: 'ignore' });
}
const icns = join(work, 'icon.icns');
execFileSync('iconutil', ['-c', 'icns', set, '-o', icns]);

const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [resolve('src-tauri/target/release/bundle/macos/TA Engine.app'), join(homedir(), 'Applications', 'TA Engine.app')];
for (const app of targets) {
  const dest = join(app, 'Contents', 'Resources', 'icon.icns');
  if (!existsSync(dest)) continue;
  copyFileSync(icns, dest);
  const now = new Date();
  utimesSync(app, now, now); // so Finder notices the new icon
  console.log(`Updated the icon of ${app}`);
}
rmSync(work, { recursive: true, force: true });

/** A minimal RGBA PNG writer. */
function png(w: number, h: number, rgba: Uint8Array): Buffer {
  const table = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (b: Buffer) => {
    let c = -1;
    for (const x of b) c = table[(c ^ x) & 255]! ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
