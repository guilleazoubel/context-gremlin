import { defineConfig } from 'vitest/config';

/**
 * Unit config: `pnpm test`. Excludes `test/integration/**` — those spawn the real bundled
 * engine over a Unix socket (45 s stop polls, 8 s offline hysteresis) and belong to
 * `pnpm test:integration` / `vitest.integration.config.ts` instead, which also serializes them
 * so two real engines never fight over CPU/FD budget in the same window.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**'],
  },
});
