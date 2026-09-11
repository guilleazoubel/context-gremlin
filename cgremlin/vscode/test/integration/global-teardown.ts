/**
 * Vitest `globalSetup` for the integration run: the leaked-process guard.
 *
 * Every integration test that boots a real engine does it through `seedStateDir()` in
 * `test/support/core-harness.ts`, which `mkdtemp`s a state dir under `os.tmpdir()` with the
 * `cgvsc-` prefix, and every harness path (`h.stop()`, per-test `cleanups`, `afterEach`) is
 * expected to leave the engine it started stopped before the test file exits.
 *
 * This has no per-test visibility into that — it runs once, after every integration test file in
 * the run has finished — so it is the backstop: if ANY `engine.js serve --config <path under a
 * cgvsc-* stateDir>` process is still alive, something's cleanup was skipped (a thrown assertion
 * before `h.stop()`, a missing `afterEach`, whatever) and the run must fail loudly rather than
 * leave a real detached process behind for the next run to trip over.
 */
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const STATE_DIR_PREFIX = path.join(tmpdir(), 'cgvsc-');

function leakedEnginePids(): string[] {
  try {
    const out = execFileSync(
      'pgrep',
      ['-f', `engine\\.js serve --config ${STATE_DIR_PREFIX}`],
      { encoding: 'utf8' },
    );
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  } catch (err) {
    // pgrep exits 1 (no match) when nothing is found — that is the good outcome, not an error.
    const status = (err as { status?: number }).status;
    if (status === 1) return [];
    throw err;
  }
}

export default async function setup(): Promise<() => void> {
  return () => {
    const leaked = leakedEnginePids();
    if (leaked.length === 0) return;
    throw new Error(
      `${leaked.length} engine.js process(es) with a harness temp stateDir (${STATE_DIR_PREFIX}*) ` +
        `outlived the integration suite: pid(s) ${leaked.join(', ')}. Some test's cleanup did not ` +
        'run — find the test that skipped `h.stop()` / its `afterEach` (likely a thrown assertion ' +
        'before cleanup) and fix it there; do not silence this guard.',
    );
  };
}
