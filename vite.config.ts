import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { port: 5173 },
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
  },
});
