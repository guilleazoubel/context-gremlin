#!/usr/bin/env node
/**
 * Builds the two bundles the extension ships, and stamps a content address into both.
 *
 * The version string alone cannot answer "is the engine on this socket the one I ship?" — it is
 * the package's version, and it stayed `0.0.1` across two phases of engine changes, so a
 * same-version upgrade was invisible and the extension adopted a stale engine forever. So the
 * engine is addressed by its content instead:
 *
 *  1. build `engine.js` from the sources;
 *  2. hash that file — this is the build id, and it changes exactly when the engine's code does;
 *  3. build both bundles again with the id defined, so `engine.js` reports it on `GET /version`
 *     and `bridge.js` exports it for the extension to compare against.
 *
 * Step 3 changes `engine.js`'s bytes, so the id is not a hash of the file that carries it — a
 * file cannot contain its own hash. It addresses the engine's *code*, which is the question.
 */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(root, '../vscode/engine');
const ENGINE_OUT = path.join(outDir, 'engine.js');
const BRIDGE_OUT = path.join(outDir, 'bridge.js');

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: 'inline',
};

function bundle(entry, outfile, define) {
  return build({ ...common, entryPoints: [path.join(root, entry)], outfile, define });
}

await bundle('src/host/engine-main.ts', ENGINE_OUT, {});
const buildId = createHash('sha256').update(readFileSync(ENGINE_OUT)).digest('hex').slice(0, 16);
// The build id says WHICH engine; the build time says WHEN, which is the only thing that can
// order two of them. Deliberately not part of the hashed build: the id stays a pure content
// address, so rebuilding the same sources still reports the same id.
const buildTime = new Date().toISOString();
const define = {
  __CGREMLIN_BUILD_ID__: JSON.stringify(buildId),
  __CGREMLIN_BUILD_TIME__: JSON.stringify(buildTime),
};

await bundle('src/host/engine-main.ts', ENGINE_OUT, define);
await bundle('src/host/extension-bridge.ts', BRIDGE_OUT, define);

process.stdout.write(`engine build id: ${buildId} (built ${buildTime})\n`);
