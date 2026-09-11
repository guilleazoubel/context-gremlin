import { loadCoreConfig } from '../config/core-config';
import { NodeFileSystem } from '../fs/node-file-system';
import { ENGINE_BUILD_ID, ENGINE_BUILD_TIME, ENGINE_NAME, ENGINE_VERSION } from '../version';

/**
 * `ENGINE_BUILD_ID` is the half of the handshake the version string cannot carry: both bundles
 * are stamped with one content address of `engine.js`, so the extension can tell the engine it
 * ships from a stale one that happens to report the same version (MG-C5).
 *
 * `ENGINE_BUILD_TIME` is what orders the two when they differ: only the side whose bundle is
 * strictly newer may replace the engine, which is what keeps two windows on two builds from
 * restarting it at each other for ever.
 */
export { ENGINE_BUILD_ID, ENGINE_BUILD_TIME, ENGINE_NAME, ENGINE_VERSION };

/**
 * Every path a caller outside this package is allowed to know about, all of
 * them resolved by the core's own loader. Nothing downstream derives a state
 * path of its own (MG-C6).
 */
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

/**
 * Loads `path` through the very same `loadCoreConfig` the engine boots with —
 * including its JSON, schema and 0600 checks, whose messages are surfaced
 * verbatim by the caller — and returns only the resolved paths.
 */
export async function loadResolvedConfig(path: string, home: string): Promise<ResolvedEnginePaths> {
  const config = await loadCoreConfig(new NodeFileSystem(), path, home);
  return {
    configPath: path,
    stateDir: config.stateDir,
    socketPath: config.socketPath!,
    sessionsDir: config.sessionsDir!,
    worktreesDir: config.worktreesDir!,
    enginePidPath: config.enginePidPath!,
    engineLogPath: config.engineLogPath!,
    repos: config.repos,
    me: config.me,
  };
}
