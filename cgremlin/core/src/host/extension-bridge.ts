import { loadCoreConfig } from '../config/core-config';
import { NodeFileSystem } from '../fs/node-file-system';
import { ENGINE_NAME, ENGINE_VERSION } from '../version';

export { ENGINE_NAME, ENGINE_VERSION };

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
