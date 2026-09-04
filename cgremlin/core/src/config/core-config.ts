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

/** Parses `raw` against {@link CoreConfigSchema}, then expands `~` in `stateDir` and derives any unset per-directory/path fields from it. */
export function resolveCoreConfig(raw: unknown, home: string): CoreConfig {
  const parsed = CoreConfigSchema.parse(raw);
  const stateDir = expandHome(parsed.stateDir, home);
  return {
    ...parsed,
    stateDir,
    sessionsDir: parsed.sessionsDir ?? `${stateDir}/sessions`,
    worktreesDir: parsed.worktreesDir ?? `${stateDir}/worktrees`,
    mirrorsDir: parsed.mirrorsDir ?? `${stateDir}/mirrors`,
    socketPath: parsed.socketPath ?? `${stateDir}/engine.sock`,
    inventoryPath: parsed.inventoryPath ?? `${stateDir}/inventory.json`,
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
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(cfg, null, 2));
}
