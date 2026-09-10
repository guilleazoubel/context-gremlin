/**
 * The one door into the bundled engine.
 *
 * Pure module — Node stdlib only, no editor API, and (R30) not so much as a mention of it.
 *
 * The engine ships as two esbuild bundles next to the compiled extension: `engine/engine.js`, which
 * is spawned, and `engine/bridge.js`, which is required here. esbuild emits no declarations and the
 * core's own ones drag `zod` in, so the *type* of what the bundle exports is declared below while
 * the *logic* stays in the engine (R9). That is what keeps path derivation in exactly one place
 * (MG-C6): the extension asks where the socket, the log and the pid file are, and never joins one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/** Every path the engine's config loader derives from `core.json`'s `stateDir`, plus its inputs. */
export interface ResolvedEnginePaths {
  configPath: string;
  stateDir: string;
  socketPath: string;
  sessionsDir: string;
  worktreesDir: string;
  enginePidPath: string;
  engineLogPath: string;
  repos: readonly string[];
  me: string;
}

export interface EngineBridge {
  /** The version of the engine this build ships — one half of the handshake (MG-C5). */
  ENGINE_VERSION: string;
  /** Rejects with the engine's own `ConfigError`, whose message is shown verbatim. */
  loadResolvedConfig(configPath: string, home: string): Promise<ResolvedEnginePaths>;
}

/** Where the bundle sits relative to the installed extension directory. */
export const BRIDGE_RELATIVE_PATH = path.join('engine', 'bridge.js');

/** The engine bundle that is spawned, same directory. Named here so nobody joins it by hand. */
export const ENGINE_RELATIVE_PATH = path.join('engine', 'engine.js');

export function engineBundlePath(extensionPath: string): string {
  return path.join(extensionPath, ENGINE_RELATIVE_PATH);
}

/**
 * Loads the bundle by absolute path. The failure worth a good message is the everyday one: a
 * developer who ran the type-checker and not the build, and therefore has `out/` but no `engine/`.
 */
export function loadBridge(extensionPath: string): EngineBridge {
  const bundlePath = path.join(extensionPath, BRIDGE_RELATIVE_PATH);
  if (!fs.existsSync(bundlePath)) {
    throw new Error(
      `The engine bundle is missing: expected ${bundlePath}. Run \`pnpm build\` in this package ` +
        '(it builds the engine before it compiles the extension); `tsc` alone does not produce it.',
    );
  }
  const load = createRequire(bundlePath);
  return load(bundlePath) as EngineBridge;
}
