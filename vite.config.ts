import { createReadStream, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const DATA_DIR = resolve(__dirname, 'data');
const ARCHIVE = /\.(hpi|ufo|ccx|gpf|gp3)$/i;

/**
 * Dev-server only: lets the debug pages read your local data/ folder.
 *   GET /__ta-data/            -> JSON list of archives [{ name, size }]
 *   GET /__ta-data/<archive>   -> the archive, with Range support
 * Nothing here is part of a production build, so game data is never bundled.
 */
function taData(): Plugin {
  return {
    name: 'ta-data',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__ta-data', (req, res) => {
        let names: string[] = [];
        try {
          names = readdirSync(DATA_DIR).filter((n) => ARCHIVE.test(n));
        } catch {
          // no data/ folder: report an empty list
        }
        const name = decodeURIComponent((req.url ?? '/').replace(/^\/+/, '').split('?')[0] ?? '');
        if (name === '') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(names.map((n) => ({ name: n, size: statSync(join(DATA_DIR, n)).size }))));
          return;
        }
        if (!names.includes(name)) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        const path = join(DATA_DIR, name);
        const size = statSync(path).size;
        const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', 'application/octet-stream');
        if (!m) {
          res.setHeader('Content-Length', size);
          createReadStream(path).pipe(res);
          return;
        }
        const start = Number(m[1]);
        const end = Math.min(Number(m[2]), size - 1);
        if (start > end) {
          res.statusCode = 416;
          res.end();
          return;
        }
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        res.setHeader('Content-Length', end - start + 1);
        createReadStream(path, { start, end }).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [taData()],
  server: { port: 5173 },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        archives: resolve(__dirname, 'archives.html'),
        models: resolve(__dirname, 'models.html'),
        maps: resolve(__dirname, 'maps.html'),
        game: resolve(__dirname, 'game.html'),
      },
    },
  },
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
  },
});
