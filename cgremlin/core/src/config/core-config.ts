import { dirname } from 'node:path';
import { z } from 'zod';
import type { SessionFileSystem } from '../fs/session-file-system';
import { ConfigError, parseLegacyWatchConfig } from '../discovery/discovery-config';
import { StageNameSchema } from '../schema/stage';

export { ConfigError } from '../discovery/discovery-config';

/** Mode `core.json` is written with, and the mode `loadCoreConfig` demands once the file holds a secret. */
export const CONFIG_FILE_MODE = 0o600;

export const LocalPrereqsSchema = z
  .object({
    hostsEntries: z.array(z.string().min(1)).default([]),
    requiredFiles: z.array(z.string().min(1)).default([]),
    requiredEnv: z.array(z.string().min(1)).default([]),
  })
  .default({});

export const LocalAppConfigSchema = z.object({
  url: z.string().url(),
  port: z.number().int().positive().max(65535).default(8080),
  devCommand: z.string().min(1).default('pnpm dev'),
  installCommand: z.string().min(1).default('pnpm install'),
  nodeVersion: z.string().min(1).optional(),
  healthTimeoutMs: z.number().int().positive().default(90_000),
  healthIntervalMs: z.number().int().positive().default(2_000),
  insecureTls: z.boolean().default(true),
  postInstallNonEmptyDirs: z.array(z.string().min(1)).default([]),
  stages: z.array(StageNameSchema).default(['develop']),
  prereqs: LocalPrereqsSchema,
});

export const VercelConfigSchema = z.object({
  scope: z.string().min(1),
  project: z.string().min(1),
  previewProject: z.string().min(1),
  envFile: z.string().min(1).default('.env.local'),
  bypassSecret: z.string().min(1).optional(),
});

export const ClerkConfigSchema = z.object({
  testEmailTemplate: z.string().min(1).default('uicheck-{key}+clerk_test@example.com'),
  verificationCode: z.string().min(1).default('424242'),
});

export const RepoEnvironmentSchema = z.object({
  localApp: LocalAppConfigSchema.optional(),
  vercel: VercelConfigSchema.optional(),
  clerk: ClerkConfigSchema.optional(),
  previewStages: z.array(StageNameSchema).default(['review', 'rereview']),
});
export type RepoEnvironment = z.infer<typeof RepoEnvironmentSchema>;

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
  environments: z.record(z.string().regex(/^[^/\s]+\/[^/\s]+$/), RepoEnvironmentSchema).default({}),
  localAppStatePath: z.string().optional(),
  attentionAcksPath: z.string().optional(),
  // R20: how long a human-turn claim stays live before any stage that trips
  // over it reaps it. Optional-with-a-default, so every core.json on disk
  // keeps loading.
  humanTurnTtlMs: z.number().int().positive().default(600_000),
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
    localAppStatePath: expandOrDerive(parsed.localAppStatePath, 'local-app.json'),
    attentionAcksPath: expandOrDerive(parsed.attentionAcksPath, 'attention-acks.json'),
  };
}

/** True when any environment carries a Vercel bypass secret — the trigger for the 0600 mode assertion. */
export function hasAnySecret(cfg: CoreConfig): boolean {
  return Object.values(cfg.environments).some((env) => env.vercel?.bypassSecret !== undefined);
}

/** Deep-clones `cfg` and replaces every `environments[*].vercel.bypassSecret` with `'[redacted]'`. */
export function redactCoreConfig(cfg: CoreConfig): CoreConfig {
  const clone = structuredClone(cfg);
  for (const env of Object.values(clone.environments)) {
    if (env.vercel?.bypassSecret !== undefined) {
      env.vercel.bypassSecret = '[redacted]';
    }
  }
  return clone;
}

/**
 * Every shape the bypass secret takes in free text: the URL query parameter
 * (`?x-vercel-protection-bypass=<v>`), the request header a brief also
 * suggests (`-H "x-vercel-protection-bypass: <v>"`) and the JSON headers
 * object an agent may echo (`{"x-vercel-protection-bypass":"<v>"}`). Group 1
 * keeps the name and separator (quotes included) so the replacement stays
 * shaped like the input; group 2 is the value, which stops at whatever could
 * close it.
 */
const BYPASS_SECRET_REF = /(x-vercel-protection-bypass"?\s*[:=]\s*"?)([^"'\s&,}]+)/gi;

/** Rewrites every `x-vercel-protection-bypass` value in free text to `<redacted>` (idempotent). */
export function redactBypassUrls(text: string): string {
  return text.replace(BYPASS_SECRET_REF, (_match, prefix: string) => `${prefix}<redacted>`);
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
  let resolved: CoreConfig;
  try {
    resolved = resolveCoreConfig(parsed, home);
  } catch (err) {
    throw new ConfigError(`Config file '${path}' failed validation: ${(err as Error).message}`);
  }
  if (hasAnySecret(resolved)) {
    const mode = await fs.statMode(path);
    if (mode !== null && (mode & 0o077) !== 0) {
      throw new ConfigError(
        `Config file '${path}' holds a secret but is mode 0${mode.toString(8)}; run chmod 600 '${path}'`,
      );
    }
  }
  return resolved;
}

const LEGACY_CONFIG_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

function unquoteLegacyValue(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

function legacyValues(legacyText: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of legacyText.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = LEGACY_CONFIG_LINE.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    values.set(key, unquoteLegacyValue(rawValue));
  }
  return values;
}

// Defaults `bin/cgremlin:69-74` applies when the legacy config omits a key.
const LEGACY_LOCAL_URL = 'https://local.findcare.dev.aplaceformom.com';
const LEGACY_LOCAL_PORT = 8080;
const LEGACY_LOCAL_DEV_CMD = 'pnpm dev';
const LEGACY_LOCAL_NODE_VERSION = '24';
const LEGACY_VERCEL_SCOPE = 'grace-0118bc61';
const LEGACY_VERCEL_PROJECT = 'grace-frontend-dev';
// The four machine prerequisites `_local_prereqs` checks (`bin/cgremlin:524-535`).
const LEGACY_PREREQS = {
  hostsEntries: ['local.findcare.dev.aplaceformom.com'],
  requiredFiles: ['/Library/LaunchDaemons/com.grace.portforward.plist', '~/.nvm/nvm.sh'],
  requiredEnv: ['NODE_AUTH_TOKEN'],
};

function legacyEnvironment(values: Map<string, string>): RepoEnvironment {
  const project = values.get('VERCEL_PROJECT') ?? LEGACY_VERCEL_PROJECT;
  const rawPort = values.get('LOCAL_PORT');
  return RepoEnvironmentSchema.parse({
    localApp: {
      url: values.get('LOCAL_URL') ?? LEGACY_LOCAL_URL,
      port: rawPort !== undefined ? Number(rawPort) : LEGACY_LOCAL_PORT,
      devCommand: values.get('LOCAL_DEV_CMD') ?? LEGACY_LOCAL_DEV_CMD,
      nodeVersion: values.get('LOCAL_NODE_VERSION') ?? LEGACY_LOCAL_NODE_VERSION,
      postInstallNonEmptyDirs: [],
      stages: ['develop'],
      prereqs: LEGACY_PREREQS,
    },
    vercel: {
      scope: values.get('VERCEL_SCOPE') ?? LEGACY_VERCEL_SCOPE,
      project,
      previewProject: project,
      ...(values.has('VERCEL_AUTOMATION_BYPASS_SECRET')
        ? { bypassSecret: values.get('VERCEL_AUTOMATION_BYPASS_SECRET') }
        : {}),
    },
  });
}

export function importLegacyConfig(
  legacyText: string,
): Pick<CoreConfig, 'repos' | 'watchAuthors' | 'me' | 'environments'> & { runnerOptions: { model?: string } } {
  const { repos, watchAuthors, me } = parseLegacyWatchConfig(legacyText);
  const values = legacyValues(legacyText);
  const model = values.get('REVIEW_MODEL');
  // The legacy tool had exactly one set of LOCAL_*/VERCEL_* settings, so they
  // can only be attached to one repo: the first watched slug.
  const [firstRepo] = repos;
  const environments: CoreConfig['environments'] =
    firstRepo === undefined ? {} : { [firstRepo]: legacyEnvironment(values) };
  return { repos, watchAuthors, me, environments, runnerOptions: model ? { model } : {} };
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
  localAppStatePath: 'local-app.json',
  attentionAcksPath: 'attention-acks.json',
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
  // Mode is set on the tmp file before the rename, so a config carrying a
  // bypass secret is never world-readable, not even briefly.
  await fs.writeFile(tmpPath, JSON.stringify(toPersist, null, 2), { mode: CONFIG_FILE_MODE });
  await fs.rename(tmpPath, path);
}
