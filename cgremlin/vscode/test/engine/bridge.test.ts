/**
 * The bridge loader (R9): the extension declares the *type* of what the engine bundle exports and
 * loads the bundle by absolute path. It never re-implements a single path derivation (MG-C6).
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { BRIDGE_RELATIVE_PATH, loadBridge } from '../../src/engine/bridge';

const fakeExtension = path.resolve(__dirname, '../support/fake-extension');

describe('loadBridge', () => {
  it('returns the bundle exports for an extension directory that has one', async () => {
    const bridge = loadBridge(fakeExtension);
    expect(bridge.ENGINE_VERSION).toBe('0.0.1-fake');
    const resolved = await bridge.loadResolvedConfig('/tmp/x/core.json', '/home/me');
    expect(resolved.socketPath).toBe('/home/me/.cgremlin-core/engine.sock');
    expect(resolved.enginePidPath).toBe('/home/me/.cgremlin-core/engine.json');
    expect(resolved.engineLogPath).toBe('/home/me/.cgremlin-core/engine.log');
  });

  it('names the artifact and the build that produces it when the bundle is missing', () => {
    const missing = path.join(os.tmpdir(), 'cgremlin-no-such-extension-9f1c');
    const expected = path.join(missing, BRIDGE_RELATIVE_PATH);
    expect(() => loadBridge(missing)).toThrowError(
      `The engine bundle is missing: expected ${expected}. Run \`pnpm build\` in this package ` +
        '(it builds the engine before it compiles the extension); `tsc` alone does not produce it.',
    );
  });

  it('points at engine/bridge.js under the extension directory', () => {
    expect(BRIDGE_RELATIVE_PATH).toBe(path.join('engine', 'bridge.js'));
  });
});
