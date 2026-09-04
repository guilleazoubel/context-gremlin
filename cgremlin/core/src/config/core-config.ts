import { dirname } from 'node:path';
import { z } from 'zod';
import type { SessionFileSystem } from '../fs/session-file-system';
import { ConfigError, parseLegacyWatchConfig } from '../discovery/discovery-config';

export { ConfigError } from '../discovery/discovery-config';

export const CoreConfigSchema = z.object({
  repos: z.array(z.string().regex(/^[^/\s]+\/[^/\s]+$/)).min(1),
  watchAuthors: z.array(z.string().min(1)).default([]),
  me: z.string().min(1),
  runner: z.enum(['claude-code', 'codex']).default('claude-code'),
  runnerOptions: z
    .object({
      model: z.string().optional(),
      permissionMode: z.string().optional(),
      sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
    })
    .default({}),
  pollIntervalMs: z.number().int().positive().default(60_000),
  prListLimit: z.number().int().positive().max(100).default(50),
  stateDir: z.string().min(1).default('~/.cgremlin'),
  sessionsDir: z.string().optional(),
  worktreesDir: z.string().optional(),
  mirrorsDir: z.string().optional(),
  socketPath: z.string().optional(),
  inventoryPath: z.string().optional(),
  reviewSkillCommand: z.string().default('/APFM:apfm-review'),
  includeLiveUiCheck: z.boolean().default(true),
  defaultBaseRef: z.string().default('origin/main'),
});

export type CoreConfig = z.infer<typeof CoreConfigSchema>;

function expandHome(value: string, home: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/')) return `${home}${value.slice(1)}`;
  return value;
}

/** Parses `raw` against {@link CoreConfigSchema}, then expands a leading `~` in every path field (stateDir and any explicit override) and derives any unset per-directory/path fields from stateDir. */
export function resolveCoreConfig(raw: unknown, home: string): CoreConfig {
  const parsed = CoreConfigSchema.parse(raw);
  const stateDir = expandHome(parsed.stateDir, home);
  const expandOrDerive = (value: string | undefined, suffix: string): string =>
    value !== undefined ? expandHome(value, home) : `${stateDir}/${suffix}`;
  return {
    ...parsed,
    stateDir,
    sessionsDir: expandOrDerive(parsed.sessionsDir, 'sessions'),
    worktreesDir: expandOrDerive(parsed.worktreesDir, 'worktrees'),
    mirrorsDir: expandOrDerive(parsed.mirrorsDir, 'mirrors'),
    socketPath: expandOrDerive(parsed.socketPath, 'engine.sock'),
    inventoryPath: expandOrDerive(parsed.inventoryPath, 'inventory.json'),
  };
}

export async function loadCoreConfig(fs: SessionFileSystem, path: string, home: string): Promise<CoreConfig> {
  const exists = await fs.exists(path);
  if (!exists) {
    throw new ConfigError(`No config file found at '${path}'`);
  }
  const raw = await fs.readFile(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Config file '${path}' is not valid JSON: ${(err as Error).message}`);
  }
  try {
    return resolveCoreConfig(parsed, home);
  } catch (err) {
    throw new ConfigError(`Config file '${path}' failed validation: ${(err as Error).message}`);
  }
}

const LEGACY_CONFIG_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

function unquoteLegacyValue(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

function extractReviewModel(legacyText: string): string | undefined {
  for (const rawLine of legacyText.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = LEGACY_CONFIG_LINE.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (key === 'REVIEW_MODEL') {
      return unquoteLegacyValue(rawValue);
    }
  }
  return undefined;
}

export function importLegacyConfig(
  legacyText: string,
): Pick<CoreConfig, 'repos' | 'watchAuthors' | 'me'> & { runnerOptions: { model?: string } } {
  const { repos, watchAuthors, me } = parseLegacyWatchConfig(legacyText);
  const model = extractReviewModel(legacyText);
  return { repos, watchAuthors, me, runnerOptions: model ? { model } : {} };
}

function randomSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// Maps each derived-path field to the suffix resolveCoreConfig would derive
// it from stateDir with — used to recognize (and omit) a value that's just
// the derived default, so persisting never bakes in a stale absolute path
// that a later stateDir change is supposed to move.
const DERIVED_PATH_SUFFIXES: Record<string, string> = {
  sessionsDir: 'sessions',
  worktreesDir: 'worktrees',
  mirrorsDir: 'mirrors',
  socketPath: 'engine.sock',
  inventoryPath: 'inventory.json',
};

export async function writeCoreConfig(
  fs: SessionFileSystem,
  path: string,
  cfg: CoreConfig,
  opts: { force: boolean },
): Promise<void> {
  const exists = await fs.exists(path);
  if (exists && !opts.force) {
    throw new ConfigError(`Config file '${path}' already exists; pass { force: true } to overwrite`);
  }
  const toPersist: Record<string, unknown> = { ...cfg };
  for (const [key, suffix] of Object.entries(DERIVED_PATH_SUFFIXES)) {
    if (toPersist[key] === `${cfg.stateDir}/${suffix}`) {
      delete toPersist[key];
    }
  }
  await fs.mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${randomSuffix()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(toPersist, null, 2));
  await fs.rename(tmpPath, path);
}
