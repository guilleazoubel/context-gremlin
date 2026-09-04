import type { SessionFileSystem } from '../fs/session-file-system';
import { loadCoreConfig, type CoreConfig } from '../config/core-config';

export interface CommandWriter {
  write(chunk: string): unknown;
}

export interface CommandIO {
  stdout: CommandWriter;
  stderr: CommandWriter;
  /** Real home directory — used to resolve `~/.cgremlin/...` defaults. */
  home: string;
  fs: SessionFileSystem;
  /** Overrides the default `${home}/.cgremlin/core.json`, e.g. from a `--config` flag. */
  configPath?: string;
}

export function defaultConfigPath(home: string): string {
  return `${home}/.cgremlin/core.json`;
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

/** Extracts a flag's value out of an argv-style args array, e.g. `--config path` -> 'path'. Does not mutate args. */
export function parseFlagValue(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx === args.length - 1) return undefined;
  return args[idx + 1];
}
