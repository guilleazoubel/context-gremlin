import { defineConfig } from 'vitest/config';

/**
 * Integration config: `pnpm test:integration`. Spawns the real bundled `engine/engine.js` over a
 * throwaway Unix socket per test file — real processes, real timers.
 *
 * - `pool: 'forks'` + `fileParallelism: false`: one file (one engine, or a small fixed set of
 *   them) runs at a time, in its own process. Running these files concurrently is what made two
 *   of them flaky — a real stop poll (45 s budget, `STOP_BUDGET_MS` in `src/engine/manager.ts`)
 *   and the 8 s offline-hysteresis window both get slower under CPU/FD contention from sibling
 *   engines, and occasionally miss a test-level timeout that isolation always clears.
 * - `globalSetup` registers the leaked-process guard (`test/integration/global-teardown.ts`):
 *   after every file in the run has finished, no `engine.js serve` process rooted in a harness
 *   temp `stateDir` (the `cgvsc-*` prefix `test/support/core-harness.ts` mkdtemps under
 *   `os.tmpdir()`) may still be alive.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    pool: 'forks',
    fileParallelism: false,
    globalSetup: ['test/integration/global-teardown.ts'],
  },
});
