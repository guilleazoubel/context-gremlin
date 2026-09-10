import type { SessionFileSystem } from '../fs/session-file-system';
import { loadCoreConfig, type CoreConfig } from '../config/core-config';

export interface CommandWriter {
  write(chunk: string): unknown;
}

export interface CommandIO {
  stdout: CommandWriter;
  stderr: CommandWriter;
  /** Real home directory — used to resolve `~/.cgremlin-core/...` defaults. */
  home: string;
  fs: SessionFileSystem;
  /** Overrides the default `${home}/.cgremlin-core/core.json`, e.g. from a `--config` flag. */
  configPath?: string;
}

export function defaultConfigPath(home: string): string {
  return `${home}/.cgremlin-core/core.json`;
}

export function configPathFor(io: CommandIO): string {
  return io.configPath ?? defaultConfigPath(io.home);
}

/** Loads core.json, printing the error to stderr and returning null on failure — the caller just checks for null and returns exit code 1. */
export async function loadConfigOrFail(io: CommandIO): Promise<CoreConfig | null> {
  try {
    return await loadCoreConfig(io.fs, configPathFor(io), io.home);
  } catch (err) {
    io.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return null;
  }
}

function errorMessageOf(body: unknown): string {
  if (body && typeof body === 'object' && 'error' in body) {
    return String((body as { error: unknown }).error);
  }
  return typeof body === 'string' ? body : JSON.stringify(body);
}

/** Prints a non-2xx response body to stderr as a plain message and returns exit code 1. */
export function printHttpError(io: CommandIO, status: number, body: unknown): number {
  io.stderr.write(`${errorMessageOf(body)} (HTTP ${status})\n`);
  return 1;
}

export function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function isSocketConnectionError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ECONNREFUSED';
}

/**
 * Loads config, then runs `fn(config)` against the socket — any connection
 * failure (no engine listening at that path) is mapped to a one-line
 * friendly message and exit 1, instead of an unhandled rejection with a
 * stack trace. `printHttpError` (for a normal non-2xx HTTP response) is
 * unrelated and still the caller's job inside `fn`.
 */
export async function runSocketCommand(
  io: CommandIO,
  fn: (config: CoreConfig) => Promise<number>,
): Promise<number> {
  const config = await loadConfigOrFail(io);
  if (!config) return 1;
  try {
    return await fn(config);
  } catch (err) {
    if (isSocketConnectionError(err)) {
      io.stderr.write(
        `engine is not running (no socket at ${config.socketPath}); start it with cgremlin-core serve\n`,
      );
    } else {
      io.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    }
    return 1;
  }
}
