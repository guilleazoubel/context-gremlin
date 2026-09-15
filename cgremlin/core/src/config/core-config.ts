import { dirname } from 'node:path';
import { z } from 'zod';
import type { SessionFileSystem } from '../fs/session-file-system';
import { ConfigError, parseLegacyWatchConfig } from '../discovery/discovery-config';
import { StageNameSchema } from '../schema/stage';
import { DEFAULT_BOT_LOGINS } from '../work/bot-login';

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

/**
 * Phase 15 — the SHARED QA environment for one repo. `url` is REQUIRED and is
 * the one thing only the user knows; nothing in the repo can derive it.
 *
 * R74: this adds NO new secret. `auth` selects which EXISTING credential the
 * brief points at — the repo's `clerk` test identity, or the 0600
 * `vercel.bypassSecret` file — and `'none'` means no test identity is
 * configured at all, which the AUTOMATIC leg must refuse to run on. Only a
 * human clicking Verify may run against a QA environment with no account.
 */
export const QaEnvironmentSchema = z.object({
  url: z.string().url(),
  /** Defaults to `url` at resolve time when absent. */
  apiBaseUrl: z.string().url().optional(),
  auth: z.enum(['clerk-test', 'vercel-bypass', 'none']).default('none'),
  healthPath: z.string().default('/'),
  healthTimeoutMs: z.number().int().positive().default(15_000),
  posthog: z.object({ project: z.string().min(1), host: z.string().url() }).optional(),
  featureFlags: z.array(z.string().min(1)).default([]),
});
export type QaEnvironment = z.infer<typeof QaEnvironmentSchema>;

export const RepoEnvironmentSchema = z.object({
  qa: QaEnvironmentSchema.optional(),
  localApp: LocalAppConfigSchema.optional(),
  vercel: VercelConfigSchema.optional(),
  clerk: ClerkConfigSchema.optional(),
  previewStages: z.array(StageNameSchema).default(['review', 'rereview']),
});
export type RepoEnvironment = z.infer<typeof RepoEnvironmentSchema>;

/**
 * R10/R32/R37/R46 — the read-only Jira source's config. `apiToken` is the ONE
 * thing the user must supply, and it is a secret: 0600 load refusal via
 * `hasAnySecret`, `redactCoreConfig`, and never in a brief, a log line, an
 * event frame, an HTTP response or `jira.json` (R44, MG-5).
 */
export const JiraConfigSchema = z.object({
  /** Documented example for this user: 'https://aplaceformom.atlassian.net'. */
  siteUrl: z.string().url(),
  /** Documented example for this user: 'guilherme.azoubel@aplaceformom.com'. */
  email: z.string().min(1),
  apiToken: z.string().min(1).optional(),
  /** Extra issue fields to request; instance-specific ones go here, never in the default set. */
  extraFields: z.array(z.string().min(1)).default([]),
  /**
   * R10/D7: injectable for tests and for a proxy; defaults to `siteUrl` at
   * resolve time. R37: browse URLs come from `siteUrl`, NEVER from here.
   */
  baseUrl: z.string().url().optional(),
  /**
   * D3's default. A user who wants "the current sprint instead" edits this ONE
   * string to `assignee = currentUser() AND sprint in openSprints()`.
   */
  jql: z.string().min(1).default('assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'),
  /** R7 as amended by R46 — EMPTY MEANS TICKET LINKING IS DISABLED, not unfiltered. */
  projectKeys: z.array(z.string().regex(/^[A-Z][A-Z0-9]+$/)).default([]),
  maxResults: z.number().int().positive().max(100).default(50),
  /** Per HTTP request. */
  timeoutMs: z.number().int().positive().default(15_000),
  /** R34 — one budget for the WHOLE Jira leg of a tick (whoami + every page). */
  scanBudgetMs: z.number().int().positive().default(20_000),
  /** Phase 15 — the statuses that mean "this ticket is in QA". Instance-specific. */
  qaStatuses: z.array(z.string().min(1)).default(['QA', 'UAT', 'Ready for QA']),
});
export type JiraConfig = z.infer<typeof JiraConfigSchema>;

export const CoreConfigSchema = z.object({
  repos: z.array(z.string().regex(/^[^/\s]+\/[^/\s]+$/)).default([]),
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
  stateDir: z.string().min(1).default('~/.cgremlin-core'),
  sessionsDir: z.string().optional(),
  worktreesDir: z.string().optional(),
  mirrorsDir: z.string().optional(),
  socketPath: z.string().optional(),
  inventoryPath: z.string().optional(),
  reviewSkillCommand: z.string().default('/APFM:apfm-review'),
  /** R75 — an enhancement that degrades silently when the skill is absent. */
  qaSkillCommand: z.string().default('/cgremlin:qa-verify'),
  /**
   * The automatic verification leg's budget and cost discipline. `autoVerify`
   * is the single switch that turns the whole leg off;
   * `maxAutoStartsPerTick` is R77's no-burn rule.
   */
  qa: z
    .object({
      autoVerify: z.boolean().default(true),
      maxAutoStartsPerTick: z.number().int().positive().default(1),
      /** E2 — the attempt cap is DATA, not a hard-coded 1. */
      maxAttemptsPerEntry: z.number().int().positive().default(1),
      scanBudgetMs: z.number().int().positive().default(20_000),
      /** R77 as amended: a cold record is a SEED, not an entry, unless this is on. */
      backfillOnFirstRun: z.boolean().default(false),
      keepAttemptsPerTicket: z.number().int().positive().default(5),
      forgetAfterDays: z.number().int().positive().default(90),
    })
    .default({}),
  includeLiveUiCheck: z.boolean().default(true),
  defaultBaseRef: z.string().default('origin/main'),
  environments: z.record(z.string().regex(/^[^/\s]+\/[^/\s]+$/), RepoEnvironmentSchema).default({}),
  localAppStatePath: z.string().optional(),
  attentionAcksPath: z.string().optional(),
  /** Derived: <stateDir>/dismissals.json — per-item "not interesting now", shared by every window. */
  dismissalsPath: z.string().optional(),
  // R13: the engine's identity/lock file and its log, derived like every
  // other per-state-dir path so the extension asks the core where they are
  // instead of joining paths itself.
  enginePidPath: z.string().optional(),
  engineLogPath: z.string().optional(),
  // R20: how long a human-turn claim stays live before any stage that trips
  // over it reaps it. Optional-with-a-default, so every core.json on disk
  // keeps loading.
  humanTurnTtlMs: z.number().int().positive().default(600_000),
  // R5: logins added to (never replacing) DEFAULT_BOT_LOGINS when deciding
  // whether a reviewer or commenter is a human.
  botLogins: z.array(z.string().min(1)).default([...DEFAULT_BOT_LOGINS]),
  jira: JiraConfigSchema.optional(),
  /** Derived: <stateDir>/jira.json. */
  jiraCachePath: z.string().optional(),
  /** R52 — the review-thread leg's own budget. */
  reviewThreads: z
    .object({ scanBudgetMs: z.number().int().positive().default(20_000) })
    .default({ scanBudgetMs: 20_000 }),
  /** R52, derived: <stateDir>/review-threads.json. */
  reviewThreadsCachePath: z.string().optional(),
  /** The pr-state leg's cache, derived: <stateDir>/pr-states.json. */
  prStatesCachePath: z.string().optional(),
  /** Phase 15, derived: <stateDir>/qa-verifications.json — the trigger's exactly-once record. */
  qaVerificationsPath: z.string().optional(),
  // D2: when true the parking lot drops the watchAuthors filter. The isMine
  // exclusion is never dropped.
  showAllRepoPrs: z.boolean().default(false),
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
  // The QA API and the QA app are the same origin unless a repo says
  // otherwise, and defaulting HERE (not at every read site) means `/config`,
  // the brief and the trigger all see the same resolved value.
  const environments = Object.fromEntries(
    Object.entries(parsed.environments).map(([slug, env]) => [
      slug,
      env.qa === undefined ? env : { ...env, qa: { ...env.qa, apiBaseUrl: env.qa.apiBaseUrl ?? env.qa.url } },
    ]),
  );
  const expandOrDerive = (value: string | undefined, suffix: string): string =>
    value !== undefined ? expandHome(value, home) : `${stateDir}/${suffix}`;
  return {
    ...parsed,
    stateDir,
    environments,
    sessionsDir: expandOrDerive(parsed.sessionsDir, 'sessions'),
    worktreesDir: expandOrDerive(parsed.worktreesDir, 'worktrees'),
    mirrorsDir: expandOrDerive(parsed.mirrorsDir, 'mirrors'),
    socketPath: expandOrDerive(parsed.socketPath, 'engine.sock'),
    inventoryPath: expandOrDerive(parsed.inventoryPath, 'inventory.json'),
    localAppStatePath: expandOrDerive(parsed.localAppStatePath, 'local-app.json'),
    attentionAcksPath: expandOrDerive(parsed.attentionAcksPath, 'attention-acks.json'),
    dismissalsPath: expandOrDerive(parsed.dismissalsPath, 'dismissals.json'),
    enginePidPath: expandOrDerive(parsed.enginePidPath, 'engine.json'),
    engineLogPath: expandOrDerive(parsed.engineLogPath, 'engine.log'),
    // R52: two derived paths, and each one needs the matching entry in
    // DERIVED_PATH_SUFFIXES below — registering only one here is the failure
    // mode ARCHITECTURE.md:528-534 documents.
    jiraCachePath: expandOrDerive(parsed.jiraCachePath, 'jira.json'),
    reviewThreadsCachePath: expandOrDerive(parsed.reviewThreadsCachePath, 'review-threads.json'),
    prStatesCachePath: expandOrDerive(parsed.prStatesCachePath, 'pr-states.json'),
    qaVerificationsPath: expandOrDerive(parsed.qaVerificationsPath, 'qa-verifications.json'),
    // R37: `baseUrl` is injectable and falls back to `siteUrl`; `siteUrl`
    // stays separately readable, because every browse URL comes from it.
    ...(parsed.jira !== undefined
      ? { jira: { ...parsed.jira, baseUrl: parsed.jira.baseUrl ?? parsed.jira.siteUrl } }
      : {}),
  };
}

/**
 * True when the config carries ANY secret — a Vercel bypass secret or (R11/R44)
 * a non-empty `jira.apiToken`. This is the trigger for the 0600 mode
 * assertion, so a config holding only a Jira token is refused world-readable
 * exactly like one holding a bypass secret.
 */
export function hasAnySecret(cfg: CoreConfig): boolean {
  if (cfg.jira?.apiToken !== undefined && cfg.jira.apiToken !== '') return true;
  return Object.values(cfg.environments).some((env) => env.vercel?.bypassSecret !== undefined);
}

/**
 * Deep-clones `cfg` and replaces every `environments[*].vercel.bypassSecret`
 * and (R11/R44) `jira.apiToken` with `'[redacted]'`.
 */
export function redactCoreConfig(cfg: CoreConfig): CoreConfig {
  const clone = structuredClone(cfg);
  for (const env of Object.values(clone.environments)) {
    if (env.vercel?.bypassSecret !== undefined) {
      env.vercel.bypassSecret = '[redacted]';
    }
  }
  if (clone.jira?.apiToken !== undefined) {
    clone.jira.apiToken = '[redacted]';
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

/**
 * Phase 15 widens this beyond the vercel shape, because `QA.md` is a brand-new
 * exposure surface: a verification agent talks to a real app, and the things
 * it can accidentally paste into a report or a log are an `Authorization`
 * header, a bearer token and a session cookie. Each pattern keeps its own
 * name/separator in group 1 so the replacement stays shaped like the input,
 * and stops at whatever could close the value, which is what makes repeated
 * application idempotent (`<redacted>` no longer matches the value shape for
 * the bearer/cookie forms, and re-matching it yields `<redacted>` again).
 */
const SECRET_REFS: readonly RegExp[] = [
  BYPASS_SECRET_REF,
  // `Authorization: Bearer <tok>` / `"authorization":"Basic <b64>"` — the
  // scheme is kept, the credential is not.
  /(authorization"?\s*[:=]\s*"?(?:Bearer|Basic|Token)\s+)([^"'\s,}]+)/gi,
  // A bare `Authorization` value with no scheme.
  /(authorization"?\s*[:=]\s*"?)(?!Bearer\b|Basic\b|Token\b|<redacted>)([^"'\s,}]+)/gi,
  // A bearer token anywhere else (a curl line, a code sample).
  /(\bBearer\s+)(?!<redacted>)([A-Za-z0-9._~+/=-]{8,})/g,
  // Any cookie pair in a Cookie/Set-Cookie header, and `__session=` anywhere.
  // The lookbehind keeps `x-vercel-set-bypass-cookie=true` — a FLAG, not a
  // credential — from being mistaken for a cookie header.
  /(?<![-\w])((?:set-)?cookie"?\s*[:=]\s*"?)(?!<redacted>)([^"'\s;,}]+)/gi,
  /(__session=)(?!<redacted>)([^"'\s;,}&]+)/gi,
];

/**
 * Rewrites every secret-shaped value in free text to `<redacted>`
 * (idempotent). Applied on every path where agent-authored or app-derived
 * text leaves the engine: event frames, the local-app status, the engine log
 * and — Phase 15 — the artifact-read route.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_REFS) {
    out = out.replace(re, (_match, prefix: string) => `${prefix}<redacted>`);
  }
  return out;
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
  dismissalsPath: 'dismissals.json',
  enginePidPath: 'engine.json',
  engineLogPath: 'engine.log',
  jiraCachePath: 'jira.json',
  reviewThreadsCachePath: 'review-threads.json',
  prStatesCachePath: 'pr-states.json',
  qaVerificationsPath: 'qa-verifications.json',
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
