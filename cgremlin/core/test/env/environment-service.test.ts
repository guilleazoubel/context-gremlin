import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  EMPTY_ENVIRONMENT,
  EnvironmentService,
  type EnvironmentServiceDeps,
  type LocalAppState,
} from '../../src/env/environment-service';
import { resolveCoreConfig, type CoreConfig } from '../../src/config/core-config';
import { KeyedLock } from '../../src/api/keyed-lock';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { FakeGhRunner } from '../support/fake-gh-runner';
import { FakeGitRunner } from '../support/fake-git-runner';
import { FakeLocalAppRunner } from '../support/fake-local-app-runner';
import type { Session } from '../../src/schema/session';

const HOME = '/home/u';
const SESSIONS_DIR = `${HOME}/.cgremlin/sessions`;
const STATE_PATH = `${HOME}/.cgremlin/local-app.json`;
const WT = '/wt/s1';
const REPO_URL = 'https://github.com/aplaceformom/grace-frontend.git';
const SLUG = 'aplaceformom/grace-frontend';
const HOSTS = '/etc/hosts';
const DEV_LOG = `${SESSIONS_DIR}/s1/logs/dev-server.log`;

const capture = JSON.parse(
  readFileSync(path.join(__dirname, '../fixtures/gh/pr-comments-vercel.json'), 'utf8'),
) as { comments: { author: { login: string }; body: string }[] };
const PR_COMMENTS_STDOUT = JSON.stringify(capture);

function vercelBody(projects: unknown[]): string {
  const payload = { isMonorepo: true, type: 'github', projects };
  return `[vc]: #h:${Buffer.from(JSON.stringify(payload)).toString('base64')}`;
}

function makeConfig(overrides: Record<string, unknown> = {}): CoreConfig {
  return resolveCoreConfig(
    {
      repos: [SLUG],
      me: 'guilleazoubel',
      environments: {
        [SLUG]: {
          localApp: {
            url: 'https://local.findcare.dev.aplaceformom.com',
            port: 8080,
            nodeVersion: '24',
            postInstallNonEmptyDirs: ['packages/grace-api/src/generated'],
            stages: ['develop'],
            prereqs: {
              hostsEntries: ['local.findcare.dev.aplaceformom.com'],
              requiredFiles: ['/Library/LaunchDaemons/com.grace.portforward.plist', '~/.nvm/nvm.sh'],
              requiredEnv: ['NODE_AUTH_TOKEN'],
            },
          },
          vercel: {
            scope: 'grace-0118bc61',
            project: 'grace-frontend-dev',
            previewProject: 'grace-frontend-dev',
            bypassSecret: 'S3CRET-VALUE',
          },
          clerk: {},
        },
      },
      ...overrides,
    },
    HOME,
  );
}

function devSession(id = 's1'): Session {
  return {
    schemaVersion: 2,
    id,
    createdAt: '2020-01-01T00:00:00.000Z',
    mode: 'development',
    stageStatus: 'active',
    workspace: { repoUrl: REPO_URL, worktreePath: WT, branch: 'feat/x' },
    lineage: { pipelineId: 'p1', parentSessionId: null, ticket: 'GS-1' },
    agent: null,
    lastRun: null,
    pr: { repo: SLUG, number: 2037, url: 'https://github.com/aplaceformom/grace-frontend/pull/2037', headSha: null, reviewedSha: null, title: null, author: null },
  };
}

function reviewSession(id = 's1'): Session {
  return {
    schemaVersion: 2,
    id,
    createdAt: '2020-01-01T00:00:00.000Z',
    mode: 'review',
    stageStatus: 'reviewing',
    reviewVersion: 0,
    lastRereviewSummary: null,
    workspace: { repoUrl: REPO_URL, worktreePath: WT, branch: 'feat/x' },
    lineage: { pipelineId: 'p1', parentSessionId: null, ticket: 'GS-1' },
    agent: null,
    lastRun: null,
    pr: { repo: SLUG, number: 2037, url: 'https://github.com/aplaceformom/grace-frontend/pull/2037', headSha: null, reviewedSha: null, title: null, author: null },
  };
}

interface Harness {
  fs: InMemoryFileSystem;
  gh: FakeGhRunner;
  git: FakeGitRunner;
  local: FakeLocalAppRunner;
  lock: KeyedLock;
  config: CoreConfig;
  service: EnvironmentService;
  make(): EnvironmentService;
}

async function harness(opts: {
  config?: CoreConfig;
  local?: FakeLocalAppRunner;
  lock?: KeyedLock;
  prereqsOk?: boolean;
  setUp?: boolean;
  bootTimeMs?: () => number;
} = {}): Promise<Harness> {
  const fs = new InMemoryFileSystem();
  const gh = new FakeGhRunner();
  const git = new FakeGitRunner();
  const local = opts.local ?? new FakeLocalAppRunner();
  const lock = opts.lock ?? new KeyedLock();
  const config = opts.config ?? makeConfig();

  await fs.mkdir(`${HOME}/.cgremlin`, { recursive: true });
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
  await fs.mkdir(WT, { recursive: true });
  await fs.writeFile(`${WT}/package.json`, JSON.stringify({ scripts: { dev: 'next dev' } }));

  if (opts.prereqsOk !== false) {
    await fs.mkdir('/etc', { recursive: true });
    await fs.writeFile(HOSTS, '127.0.0.1 local.findcare.dev.aplaceformom.com\n');
    await fs.mkdir('/Library/LaunchDaemons', { recursive: true });
    await fs.writeFile('/Library/LaunchDaemons/com.grace.portforward.plist', 'x');
    await fs.mkdir(`${HOME}/.nvm`, { recursive: true });
    await fs.writeFile(`${HOME}/.nvm/nvm.sh`, 'x');
  }
  if (opts.setUp !== false) {
    await fs.writeFile(`${WT}/.env.local`, 'A=1\n');
    await fs.mkdir(`${WT}/node_modules`, { recursive: true });
    await fs.mkdir(`${WT}/packages/grace-api/src/generated`, { recursive: true });
    await fs.writeFile(`${WT}/packages/grace-api/src/generated/types.ts`, 'x');
  }

  const deps = (): EnvironmentServiceDeps => ({
    fs,
    gh,
    git,
    local,
    config,
    sessionsDir: SESSIONS_DIR,
    statePath: STATE_PATH,
    lock,
    env: opts.prereqsOk === false ? { HOME } : { HOME, NODE_AUTH_TOKEN: 'tok' },
    now: () => new Date('2020-02-02T03:04:05.000Z'),
    ...(opts.bootTimeMs === undefined ? {} : { bootTimeMs: opts.bootTimeMs }),
  });

  return { fs, gh, git, local, lock, config, service: new EnvironmentService(deps()), make: () => new EnvironmentService(deps()) };
}

/** What a successful `pnpm install` leaves behind, so the post-install check passes. */
async function installedGeneratedDir(h: Harness): Promise<void> {
  await h.fs.mkdir(`${WT}/packages/grace-api/src/generated`, { recursive: true });
  await h.fs.writeFile(`${WT}/packages/grace-api/src/generated/types.ts`, 'x');
}

async function readState(fs: InMemoryFileSystem): Promise<LocalAppState> {
  return JSON.parse(await fs.readFile(STATE_PATH)) as LocalAppState;
}

describe('EnvironmentService — resolution', () => {
  it('environmentFor resolves the repo slug out of the clone URL', async () => {
    const h = await harness();
    expect(h.service.environmentFor(REPO_URL)?.vercel?.project).toBe('grace-frontend-dev');
  });

  it('environmentFor returns undefined for an unconfigured repo', async () => {
    const h = await harness();
    expect(h.service.environmentFor('https://github.com/aplaceformom/grace.git')).toBeUndefined();
  });

  it('wantsLocalApp/wantsPreview follow the configured stage lists', async () => {
    const h = await harness();
    expect(h.service.wantsLocalApp(REPO_URL, 'develop')).toBe(true);
    expect(h.service.wantsLocalApp(REPO_URL, 'review')).toBe(false);
    expect(h.service.wantsPreview(REPO_URL, 'review')).toBe(true);
    expect(h.service.wantsPreview(REPO_URL, 'rereview')).toBe(true);
    expect(h.service.wantsPreview(REPO_URL, 'develop')).toBe(false);
  });

  it('wantsLocalApp/wantsPreview are false for a repo with no environment', async () => {
    const h = await harness();
    const other = 'https://github.com/aplaceformom/grace.git';
    expect(h.service.wantsLocalApp(other, 'develop')).toBe(false);
    expect(h.service.wantsPreview(other, 'review')).toBe(false);
  });
});

describe('EnvironmentService — prereqs', () => {
  it('returns [] when every prereq is satisfied', async () => {
    const h = await harness();
    expect(await h.service.checkPrereqs(h.config.environments[SLUG])).toEqual([]);
  });

  it('reports a missing /etc/hosts entry, a missing file and an unset env var with the legacy wording', async () => {
    const h = await harness({ prereqsOk: false });
    await h.fs.mkdir('/etc', { recursive: true });
    await h.fs.writeFile(HOSTS, '127.0.0.1 localhost\n');
    const messages = await h.service.checkPrereqs(h.config.environments[SLUG]);
    expect(messages).toEqual([
      "PREREQ: /etc/hosts is missing 'local.findcare.dev.aplaceformom.com'. Run 'pnpm setup:local' in the repo, with you present (needs sudo).",
      "PREREQ: the 443→8080 port-forward daemon is missing. Run 'pnpm setup:local' in the repo, with you present (needs sudo).",
      'PREREQ: nvm not found at ~/.nvm/nvm.sh (needed for Node 24).',
      'PREREQ: NODE_AUTH_TOKEN is not set (needed for @aplaceformom/* packages). Export a GitHub PAT with read:packages (the gh oauth token lacks that scope).',
    ]);
  });

  it('reports a Vercel logout with the legacy wording', async () => {
    const h = await harness();
    h.local.queueExec({ code: 1, stdout: '', stderr: 'no' });
    expect(await h.service.checkPrereqs(h.config.environments[SLUG])).toEqual([
      "PREREQ: not logged into Vercel. Run 'vercel login'.",
    ]);
  });

  it('start degrades to unavailable, naming every failing prereq, and never spawns', async () => {
    const h = await harness({ prereqsOk: false });
    await h.fs.mkdir('/etc', { recursive: true });
    await h.fs.writeFile(HOSTS, '');
    const status = await h.service.start(devSession());
    expect(status.state).toBe('unavailable');
    expect(status.reason).toContain('/etc/hosts is missing');
    expect(status.reason).toContain('NODE_AUTH_TOKEN is not set');
    expect(h.local.startCalls).toEqual([]);
  });
});

describe('EnvironmentService — ensureSetup', () => {
  it('fast path: does nothing when env file, node_modules and generated dirs are all present', async () => {
    const h = await harness();
    await h.service.ensureSetup(devSession(), h.config.environments[SLUG], DEV_LOG, false);
    expect(h.local.execCalls).toEqual([]);
    expect(h.git.calls).toEqual([]);
  });

  it('cold path: runs link, env pull, the gitignore guard and install in that order', async () => {
    const h = await harness({ setUp: false });
    await h.fs.writeFile(`${WT}/.env.local`, 'A=1\n');
    await installedGeneratedDir(h);
    await h.service.ensureSetup(devSession(), h.config.environments[SLUG], DEV_LOG, false);
    expect(h.local.execCalls.map((c) => c.command)).toEqual([
      'vercel link --yes --scope grace-0118bc61 --project grace-frontend-dev',
      'vercel env pull .env.local',
      'pnpm install',
    ]);
    expect(h.git.calls[0].args).toEqual(['check-ignore', '-q', '.env.local', '.vercel']);
  });

  it('fresh: true forces the cold path even when the fast-path conditions hold', async () => {
    const h = await harness();
    await h.service.ensureSetup(devSession(), h.config.environments[SLUG], DEV_LOG, true);
    expect(h.local.execCalls.map((c) => c.command)).toContain('vercel env pull .env.local');
  });

  it('a postInstallNonEmptyDirs entry that does not exist at all triggers the cold path', async () => {
    const h = await harness();
    await h.fs.remove(`${WT}/packages/grace-api/src/generated/types.ts`);
    await h.fs.mkdir(`${WT}/packages/grace-api/src/generated2`, { recursive: true });
    await h.service.ensureSetup(devSession(), h.config.environments[SLUG], DEV_LOG, false).catch(() => undefined);
    expect(h.local.execCalls.map((c) => c.command)).toContain('vercel link --yes --scope grace-0118bc61 --project grace-frontend-dev');
  });

  it('gitignore guard: a satisfied check-ignore appends nothing and makes exactly one git call', async () => {
    const h = await harness({ setUp: false });
    await h.fs.writeFile(`${WT}/.env.local`, 'A=1\n');
    await installedGeneratedDir(h);
    await h.service.ensureSetup(devSession(), h.config.environments[SLUG], DEV_LOG, false);
    expect(h.git.calls).toHaveLength(1);
  });

  it('gitignore guard: a failing check-ignore appends both lines to the resolved info/exclude', async () => {
    const h = await harness({ setUp: false });
    await h.fs.writeFile(`${WT}/.env.local`, 'A=1\n');
    await h.fs.mkdir('/repo/.git/worktrees/s1/info', { recursive: true });
    await h.fs.writeFile('/repo/.git/worktrees/s1/info/exclude', '# existing\n');
    h.git.queueResponse(new Error('exit 1'));
    h.git.queueResponse({ stdout: '/repo/.git/worktrees/s1/info/exclude\n', stderr: '' });
    await installedGeneratedDir(h);
    await h.service.ensureSetup(devSession(), h.config.environments[SLUG], DEV_LOG, false);
    expect(h.git.calls[1].args).toEqual(['rev-parse', '--git-path', 'info/exclude']);
    expect(await h.fs.readFile('/repo/.git/worktrees/s1/info/exclude')).toBe('# existing\n.env.local\n.vercel\n');
  });

  it('gitignore guard: a second cold run does not duplicate the exclude lines', async () => {
    const h = await harness({ setUp: false });
    await h.fs.writeFile(`${WT}/.env.local`, 'A=1\n');
    await h.fs.mkdir('/repo/.git/info', { recursive: true });
    await h.fs.writeFile('/repo/.git/info/exclude', '.env.local\n.vercel\n');
    h.git.queueResponse(new Error('exit 1'));
    h.git.queueResponse({ stdout: '/repo/.git/info/exclude\n', stderr: '' });
    await installedGeneratedDir(h);
    await h.service.ensureSetup(devSession(), h.config.environments[SLUG], DEV_LOG, false);
    expect(await h.fs.readFile('/repo/.git/info/exclude')).toBe('.env.local\n.vercel\n');
  });

  it('a failing vercel link degrades with the legacy message', async () => {
    const h = await harness({ setUp: false });
    h.local.queueExec({ code: 0, stdout: '', stderr: '' }); // vercel whoami
    h.local.queueExec({ code: 1, stdout: '', stderr: '' });
    const status = await h.service.start(devSession());
    expect(status.state).toBe('unavailable');
    expect(status.reason).toBe('ERROR: vercel link failed (scope grace-0118bc61 / project grace-frontend-dev)');
  });

  it('a failing vercel env pull degrades with the legacy message', async () => {
    const h = await harness({ setUp: false });
    h.local.queueExec({ code: 0, stdout: '', stderr: '' }); // vercel whoami
    h.local.queueExec({ code: 0, stdout: '', stderr: '' });
    h.local.queueExec({ code: 1, stdout: '', stderr: '' });
    const status = await h.service.start(devSession());
    expect(status.reason).toBe('ERROR: vercel env pull failed');
  });

  it('an env file with no assignments degrades with the legacy message', async () => {
    const h = await harness({ setUp: false });
    const status = await h.service.start(devSession());
    expect(status.reason).toBe('ERROR: .env.local came back empty');
  });

  it('a failing install degrades naming the install log', async () => {
    const h = await harness({ setUp: false });
    await h.fs.writeFile(`${WT}/.env.local`, 'A=1\n');
    h.local.queueExec({ code: 0, stdout: '', stderr: '' }); // vercel whoami
    h.local.queueExec({ code: 0, stdout: '', stderr: '' });
    h.local.queueExec({ code: 0, stdout: '', stderr: '' });
    h.local.queueExec({ code: 1, stdout: '', stderr: '' });
    const status = await h.service.start(devSession());
    expect(status.reason).toBe(`ERROR: pnpm install failed — see ${DEV_LOG}.install`);
  });

  it('an empty generated dir after install degrades with the legacy backend message', async () => {
    const h = await harness({ setUp: false });
    await h.fs.writeFile(`${WT}/.env.local`, 'A=1\n');
    const status = await h.service.start(devSession());
    expect(status.reason).toBe(
      `ERROR: dev backend unreachable — API types not generated (packages/grace-api/src/generated is empty); the app won't run correctly. See ${DEV_LOG}.install`,
    );
  });

  it('wrapper exit 78 from exec becomes a LocalAppPrereqError reason', async () => {
    const h = await harness({ setUp: false });
    await h.fs.writeFile(`${WT}/.env.local`, 'A=1\n');
    h.local.queueExec({ code: 0, stdout: '', stderr: '' }); // vercel whoami
    h.local.queueExec({ code: 0, stdout: '', stderr: '' });
    h.local.queueExec({ code: 0, stdout: '', stderr: '' });
    h.local.queueExec({ code: 78, stdout: '', stderr: '' });
    const status = await h.service.start(devSession());
    expect(status.state).toBe('unavailable');
    expect(status.reason).toContain('PREREQ: could not select Node 24 via nvm');
  });
});

describe('EnvironmentService — start, single instance', () => {
  it('F2: an unexpected error from the runner rejects start() instead of degrading to unavailable', async () => {
    class ThrowingRunner extends FakeLocalAppRunner {
      async start(): Promise<never> {
        throw new TypeError('boom');
      }
    }
    const h = await harness({ local: new ThrowingRunner() });
    await expect(h.service.start(devSession())).rejects.toThrow(TypeError);
    await expect(h.service.start(devSession())).rejects.toThrow('boom');
  });

  it('F2: a plain Error (not one of the expected local-app error classes) also rejects start()', async () => {
    class ThrowingRunner extends FakeLocalAppRunner {
      async start(): Promise<never> {
        throw new Error('x');
      }
    }
    const h = await harness({ local: new ThrowingRunner() });
    await expect(h.service.start(devSession())).rejects.toThrow('x');
  });

  it('MG-6 no-port-steal: a foreign listener is reported and never killed', async () => {
    const h = await harness();
    h.local.setPortListener(9999);
    const status = await h.service.start(devSession());
    expect(status.state).toBe('unavailable');
    expect(status.reason).toBe(
      'port 8080 is held by pid 9999, which the engine did not start — it will not be killed; stop it yourself or change localApp.port',
    );
    expect(h.local.startCalls).toEqual([]);
    expect(h.local.stopCalls).toEqual([]);
  });

  it('a leftover this engine started is reported as ours, pointing at local stop', async () => {
    const h = await harness();
    await h.fs.writeFile(
      STATE_PATH,
      JSON.stringify({ sessionId: 'other', repoSlug: SLUG, url: 'https://local.findcare.dev.aplaceformom.com', port: 8080, pid: 4242, pgid: 4242, logPath: DEV_LOG, startedAt: '2020-01-01T00:00:00.000Z' }),
    );
    h.local.setPortListener(4242);
    const status = await h.service.start(devSession());
    expect(status.state).toBe('unavailable');
    expect(status.reason).toContain("run 'cgremlin-core local stop' to release it");
    expect(h.local.startCalls).toEqual([]);
    expect(h.local.stopCalls).toEqual([]);
  });

  it('reuses a healthy app already owned by this session', async () => {
    const h = await harness();
    await h.fs.writeFile(
      STATE_PATH,
      JSON.stringify({ sessionId: 's1', repoSlug: SLUG, url: 'https://local.findcare.dev.aplaceformom.com', port: 8080, pid: 4242, pgid: 4242, logPath: DEV_LOG, startedAt: '2020-01-01T00:00:00.000Z' }),
    );
    h.local.setAlive(true);
    h.local.queueHealth({ ok: true, status: 200, reason: null, exited: false });
    const status = await h.service.start(devSession());
    expect(status.state).toBe('running');
    expect(status.pid).toBe(4242);
    expect(h.local.startCalls).toEqual([]);
  });

  it('clears a stale state file for this session and starts fresh', async () => {
    const h = await harness();
    await h.fs.writeFile(
      STATE_PATH,
      JSON.stringify({ sessionId: 's1', repoSlug: SLUG, url: 'https://local.findcare.dev.aplaceformom.com', port: 8080, pid: 4242, pgid: 4242, logPath: DEV_LOG, startedAt: '2020-01-01T00:00:00.000Z' }),
    );
    h.local.setAlive(false);
    const status = await h.service.start(devSession());
    expect(status.state).toBe('running');
    expect(h.local.startCalls).toHaveLength(1);
    expect((await readState(h.fs)).pid).toBe(1234);
  });

  it('starts the dev command in the worktree, logging to the session log', async () => {
    const h = await harness();
    const status = await h.service.start(devSession());
    expect(status.state).toBe('running');
    expect(status.url).toBe('https://local.findcare.dev.aplaceformom.com');
    expect(h.local.startCalls[0]).toEqual({ cwd: WT, command: 'pnpm dev', nodeVersion: '24', logPath: DEV_LOG });
  });

  it('a dev command that exits before the healthcheck fails fast with the head of its log', async () => {
    class ExitingRunner extends FakeLocalAppRunner {
      async headLog(): Promise<string> {
        return 'Run \'pnpm setup:local\' once before starting local HTTPS development.\nhttps://h/?x-vercel-protection-bypass=S3CRET-VALUE';
      }
    }
    const local = new ExitingRunner();
    const h = await harness({ local });
    local.queueHealth({ ok: false, status: null, reason: null, exited: true });
    const status = await h.service.start(devSession());
    expect(status.state).toBe('unavailable');
    expect(status.reason).toContain("Run 'pnpm setup:local' once before starting local HTTPS development.");
    expect(status.reason).toContain('x-vercel-protection-bypass=<redacted>');
    expect(status.reason).not.toContain('S3CRET-VALUE');
    expect(local.stopCalls).toEqual([]);
  });

  it('hands the spawned process to the healthcheck so a dead dev command ends the wait immediately', async () => {
    const seen: Array<{ timeoutMs: number; proc?: { pid: number } }> = [];
    class RecordingRunner extends FakeLocalAppRunner {
      async healthcheck(url: string, opts: Parameters<FakeLocalAppRunner['healthcheck']>[1]) {
        seen.push({ timeoutMs: opts.timeoutMs, proc: opts.proc });
        return super.healthcheck(url, opts);
      }
    }
    const local = new RecordingRunner();
    const h = await harness({ local });
    await h.service.start(devSession());
    expect(seen).toEqual([{ timeoutMs: 90_000, proc: { pid: 1234, pgid: 1234, startedAt: '2020-01-01T00:00:00.000Z' } }]);
  });

  it('a plain healthcheck timeout stops the process once and reports the log tail', async () => {
    class TailRunner extends FakeLocalAppRunner {
      async tailLog(): Promise<string> {
        return 'last twenty lines';
      }
    }
    const local = new TailRunner();
    const h = await harness({ local });
    local.queueHealth({ ok: false, status: null, reason: 'timeout', exited: false });
    const status = await h.service.start(devSession());
    expect(status.state).toBe('unavailable');
    expect(status.reason).toContain('did not come up');
    expect(status.reason).toContain('last twenty lines');
    expect(local.stopCalls).toHaveLength(1);
  });

  it('records the listening pid and re-derives its pgid when the wrapper forked', async () => {
    class ForkingRunner extends FakeLocalAppRunner {
      async start(spec: Parameters<FakeLocalAppRunner['start']>[0]) {
        const proc = await super.start(spec);
        this.setPortListener(200);
        return proc;
      }
    }
    const local = new ForkingRunner();
    local.setStartResult({ pid: 100, pgid: 100, startedAt: '2020-01-01T00:00:00.000Z' });
    local.setPgid(200, 250);
    const h = await harness({ local });
    await h.service.start(devSession());
    const state = await readState(h.fs);
    expect(state.pid).toBe(200);
    expect(state.pgid).toBe(250);
  });

  it('redacts bypass URLs out of the logTail it returns', async () => {
    class SecretLogRunner extends FakeLocalAppRunner {
      async tailLog(): Promise<string> {
        return 'GET https://h/?x-vercel-protection-bypass=S3CRET-VALUE&x-vercel-set-bypass-cookie=true';
      }
    }
    const local = new SecretLogRunner();
    const h = await harness({ local });
    const status = await h.service.start(devSession());
    expect(status.logTail).toContain('x-vercel-protection-bypass=<redacted>');
    expect(status.logTail).not.toContain('S3CRET-VALUE');
  });

  it('MG-10 state-file-mutex: concurrent starts for two sessions produce exactly one spawn', async () => {
    const h = await harness();
    await h.fs.mkdir(`${WT}2`, { recursive: true });
    await h.fs.writeFile(`${WT}2/package.json`, JSON.stringify({ scripts: { dev: 'next dev' } }));
    const s2: Session = { ...devSession('s2'), workspace: { repoUrl: REPO_URL, worktreePath: WT, branch: 'b' } };
    const [a, b] = await Promise.all([h.service.start(devSession('s1')), h.service.start(s2)]);
    expect(h.local.startCalls).toHaveLength(1);
    expect([a.state, b.state].sort()).toEqual(['running', 'unavailable']);
    expect((await readState(h.fs)).sessionId).toBe([a, b].find((s) => s.state === 'running')!.sessionId);
  });

  it('MG-10 state-file-mutex: without the local-app lock the same race spawns twice', async () => {
    const noopLock = { withLock: <T,>(_key: string, fn: () => Promise<T>) => fn() } as unknown as KeyedLock;
    const h = await harness({ lock: noopLock });
    const s2 = devSession('s2');
    await Promise.all([h.service.start(devSession('s1')), h.service.start(s2)]);
    expect(h.local.startCalls).toHaveLength(2);
  });

  it('writes the state file atomically and reads it back from a fresh instance', async () => {
    const h = await harness();
    await h.service.start(devSession());
    const leftovers = (await h.fs.readdir(`${HOME}/.cgremlin`)).filter((n) => n.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    expect((await h.make().status()).sessionId).toBe('s1');
  });
});

describe('EnvironmentService — stop and reap', () => {
  it('stop with no owner reports stopped and kills nothing', async () => {
    const h = await harness();
    const status = await h.service.stop();
    expect(status.state).toBe('stopped');
    expect(h.local.stopCalls).toEqual([]);
  });

  it('stop by a non-owner leaves the owner running and kills nothing', async () => {
    const h = await harness();
    await h.service.start(devSession('s1'));
    const status = await h.service.stop('other-session');
    expect(status.state).toBe('running');
    expect(status.sessionId).toBe('s1');
    expect(h.local.stopCalls).toEqual([]);
  });

  it('stop by the owner stops the group and clears the state file', async () => {
    const h = await harness();
    await h.service.start(devSession('s1'));
    const status = await h.service.stop('s1');
    expect(status.state).toBe('stopped');
    expect(h.local.stopCalls).toHaveLength(1);
    expect(await h.fs.exists(STATE_PATH)).toBe(false);
  });

  it('W2/R6 stop that leaves a foreign process on the port reports it instead of claiming stopped', async () => {
    const h = await harness();
    await h.service.start(devSession('s1'));
    h.local.setStopResult({ freed: false, foreignListener: 9999 });
    const status = await h.service.stop('s1');
    expect(status.state).toBe('unavailable');
    expect(status.reason).toContain('9999');
    expect(status.reason).toContain('port 8080');
    expect(await h.fs.exists(STATE_PATH)).toBe(false);
  });

  it('MG-11 reap-only-our-own: a live recorded group is stopped and the state cleared', async () => {
    const h = await harness();
    await h.service.start(devSession('s1'));
    h.local.setAlive(true);
    const result = await h.make().reconcileOrphans();
    expect(result.reaped?.sessionId).toBe('s1');
    expect(result.alreadyDead).toBe(false);
    expect(h.local.stopCalls).toHaveLength(1);
    expect(await h.fs.exists(STATE_PATH)).toBe(false);
  });

  it('MG-11 reap-only-our-own: a dead recorded group is only cleared', async () => {
    const h = await harness();
    await h.service.start(devSession('s1'));
    h.local.setAlive(false);
    const result = await h.make().reconcileOrphans();
    expect(result.alreadyDead).toBe(true);
    expect(result.reaped?.sessionId).toBe('s1');
    expect(h.local.stopCalls).toEqual([]);
    expect(await h.fs.exists(STATE_PATH)).toBe(false);
  });

  it('W3 pid-reuse: a record predating the last boot that no longer owns the port is cleared, not signalled', async () => {
    const h = await harness({ bootTimeMs: () => Date.parse('2021-01-01T00:00:00.000Z') });
    await h.fs.writeFile(
      STATE_PATH,
      JSON.stringify({ sessionId: 's1', repoSlug: SLUG, url: 'https://local.findcare.dev.aplaceformom.com', port: 8080, pid: 4242, pgid: 4242, logPath: DEV_LOG, startedAt: '2020-01-01T00:00:00.000Z' }),
    );
    h.local.setAlive(true);
    h.local.setPortListener(null);

    const result = await h.service.reconcileOrphans();

    expect(h.local.stopCalls).toEqual([]);
    expect(result.reaped).toBeNull();
    expect(result.stale?.sessionId).toBe('s1');
    expect(await h.fs.exists(STATE_PATH)).toBe(false);
  });

  it('W3 pid-reuse: a record predating the boot that still owns the port is reaped', async () => {
    const h = await harness({ bootTimeMs: () => Date.parse('2021-01-01T00:00:00.000Z') });
    await h.fs.writeFile(
      STATE_PATH,
      JSON.stringify({ sessionId: 's1', repoSlug: SLUG, url: 'https://local.findcare.dev.aplaceformom.com', port: 8080, pid: 4242, pgid: 4242, logPath: DEV_LOG, startedAt: '2020-01-01T00:00:00.000Z' }),
    );
    h.local.setAlive(true);
    h.local.setPortListener(4242);

    const result = await h.service.reconcileOrphans();

    expect(result.reaped?.sessionId).toBe('s1');
    expect(result.stale).toBeNull();
    expect(h.local.stopCalls).toHaveLength(1);
  });

  it('W3 pid-reuse: a record started after the last boot is reaped even with nothing on the port', async () => {
    const h = await harness({ bootTimeMs: () => Date.parse('2019-01-01T00:00:00.000Z') });
    await h.fs.writeFile(
      STATE_PATH,
      JSON.stringify({ sessionId: 's1', repoSlug: SLUG, url: 'https://local.findcare.dev.aplaceformom.com', port: 8080, pid: 4242, pgid: 4242, logPath: DEV_LOG, startedAt: '2020-01-01T00:00:00.000Z' }),
    );
    h.local.setAlive(true);
    h.local.setPortListener(null);

    const result = await h.service.reconcileOrphans();

    expect(result.reaped?.sessionId).toBe('s1');
    expect(h.local.stopCalls).toHaveLength(1);
  });

  it('W3 pid-reuse: stop refuses to signal a group recorded before the last boot and just clears the state', async () => {
    const h = await harness({ bootTimeMs: () => Date.parse('2021-01-01T00:00:00.000Z') });
    await h.fs.writeFile(
      STATE_PATH,
      JSON.stringify({ sessionId: 's1', repoSlug: SLUG, url: 'https://local.findcare.dev.aplaceformom.com', port: 8080, pid: 4242, pgid: 4242, logPath: DEV_LOG, startedAt: '2020-01-01T00:00:00.000Z' }),
    );
    h.local.setAlive(true);
    h.local.setPortListener(null);

    const status = await h.service.stop('s1');

    expect(status.state).toBe('stopped');
    expect(h.local.stopCalls).toEqual([]);
    expect(await h.fs.exists(STATE_PATH)).toBe(false);
  });

  it('MG-11 reap-only-our-own: a foreign listener with no state file is untouched', async () => {
    const h = await harness();
    h.local.setPortListener(9999);
    const result = await h.service.reconcileOrphans();
    expect(result).toEqual({ reaped: null, alreadyDead: false, stale: null });
    expect(h.local.stopCalls).toEqual([]);
    expect(await h.fs.exists(STATE_PATH)).toBe(false);
  });
});

describe('EnvironmentService — preview URL', () => {
  it('asks gh for the PR comments and returns the configured project preview URL', async () => {
    const h = await harness();
    h.gh.queueResponse({ stdout: PR_COMMENTS_STDOUT });
    const result = await h.service.previewUrlFor(reviewSession());
    expect(h.gh.calls[0]).toEqual(['pr', 'view', '2037', '--repo', SLUG, '--json', 'comments']);
    expect(result.url).toBe(
      'https://grace-frontend-dev-git-codex-gs-68-realtime-account-seam.preview.findcare.dev.aplaceformom.com',
    );
    expect(result.reason).toBeNull();
    expect(result.status).toBe('DEPLOYED');
  });

  it('only decodes comments authored by the vercel bot', async () => {
    const h = await harness();
    const spoofed = {
      comments: [
        { author: { login: 'not-vercel' }, body: vercelBody([{ name: 'grace-frontend-dev', projectId: 'p', rootDirectory: null, inspectorUrl: 'https://vercel.com/x', previewUrl: 'evil.example.com', nextCommitStatus: 'DEPLOYED' }]) },
      ],
    };
    h.gh.queueResponse({ stdout: JSON.stringify(spoofed) });
    const result = await h.service.previewUrlFor(reviewSession());
    expect(result.url).toBeNull();
    expect(result.reason).toBe('no vercel comment on the PR');
  });

  it('a PENDING project still yields its URL', async () => {
    const h = await harness();
    const body = vercelBody([
      { name: 'grace-frontend-dev', projectId: 'p', rootDirectory: null, inspectorUrl: 'https://vercel.com/x', previewUrl: 'pending.example.com', nextCommitStatus: 'PENDING' },
    ]);
    h.gh.queueResponse({ stdout: JSON.stringify({ comments: [{ author: { login: 'vercel' }, body }] }) });
    const result = await h.service.previewUrlFor(reviewSession());
    expect(result).toEqual({ url: 'https://pending.example.com', reason: null, status: 'PENDING' });
  });

  it('a project with a null previewUrl reports the status instead', async () => {
    const h = await harness();
    const body = vercelBody([
      { name: 'grace-frontend-dev', projectId: 'p', rootDirectory: null, inspectorUrl: 'https://vercel.com/x', previewUrl: null, nextCommitStatus: 'IGNORED' },
    ]);
    h.gh.queueResponse({ stdout: JSON.stringify({ comments: [{ author: { login: 'vercel' }, body }] }) });
    const result = await h.service.previewUrlFor(reviewSession());
    expect(result.url).toBeNull();
    expect(result.reason).toBe("project 'grace-frontend-dev' has no preview URL yet (nextCommitStatus=IGNORED)");
  });

  it('an unknown project name is reported', async () => {
    const h = await harness();
    const body = vercelBody([
      { name: 'other', projectId: 'p', rootDirectory: null, inspectorUrl: 'https://vercel.com/x', previewUrl: 'o.example.com', nextCommitStatus: 'DEPLOYED' },
    ]);
    h.gh.queueResponse({ stdout: JSON.stringify({ comments: [{ author: { login: 'vercel' }, body }] }) });
    const result = await h.service.previewUrlFor(reviewSession());
    expect(result.reason).toBe("no project 'grace-frontend-dev' in the vercel comment");
  });

  it('a PR with no vercel comment is reported', async () => {
    const h = await harness();
    h.gh.queueResponse({ stdout: JSON.stringify({ comments: [{ author: { login: 'apfm-sonar' }, body: '[BLANKED]' }] }) });
    expect((await h.service.previewUrlFor(reviewSession())).reason).toBe('no vercel comment on the PR');
  });

  it('a gh failure is reported, never thrown', async () => {
    const h = await harness();
    h.gh.queueResponse(new Error('gh pr view exited with code 1: boom'));
    const result = await h.service.previewUrlFor(reviewSession());
    expect(result.url).toBeNull();
    expect(result.reason).toContain('gh pr view failed');
  });
});

describe('EnvironmentService — bypass secret file', () => {
  it('writes the secret at 0600 with a trailing newline and returns its path', async () => {
    const h = await harness();
    const dir = `${SESSIONS_DIR}/s1`;
    await h.fs.mkdir(dir, { recursive: true });
    const written = await h.service.writeBypassSecret(dir, REPO_URL);
    expect(written).toBe(`${dir}/.bypass-secret`);
    expect(await h.fs.readFile(written!)).toBe('S3CRET-VALUE\n');
    expect(await h.fs.statMode(written!)).toBe(0o600);
  });

  it('writes nothing when the repo has no configured secret', async () => {
    const config = makeConfig({ environments: { [SLUG]: { previewStages: ['review'] } } });
    const h = await harness({ config });
    const dir = `${SESSIONS_DIR}/s1`;
    await h.fs.mkdir(dir, { recursive: true });
    expect(await h.service.writeBypassSecret(dir, REPO_URL)).toBeNull();
    expect(await h.fs.exists(`${dir}/.bypass-secret`)).toBe(false);
  });

  it('clearBypassSecret removes the file and is a no-op when it is absent', async () => {
    const h = await harness();
    const dir = `${SESSIONS_DIR}/s1`;
    await h.fs.mkdir(dir, { recursive: true });
    await h.service.writeBypassSecret(dir, REPO_URL);
    await h.service.clearBypassSecret(dir);
    expect(await h.fs.exists(`${dir}/.bypass-secret`)).toBe(false);
    await expect(h.service.clearBypassSecret(dir)).resolves.toBeUndefined();
  });
});

describe('EnvironmentService — brief context', () => {
  it('a review stage carries the preview URL, the secret path and the Clerk defaults', async () => {
    const h = await harness();
    h.gh.queueResponse({ stdout: PR_COMMENTS_STDOUT });
    const ctx = await h.service.briefContext(reviewSession(), 'review');
    expect(ctx.previewUrl).toContain('grace-frontend-dev-git-');
    expect(ctx.localUrl).toBeNull();
    expect(ctx.bypassSecretPath).toBe(`${SESSIONS_DIR}/s1/.bypass-secret`);
    expect(ctx.clerk).toEqual({ emailTemplate: 'uicheck-{key}+clerk_test@example.com', verificationCode: '424242' });
    // F2: previewUrlFor's `status` must be copied through to the brief context.
    expect(ctx.previewStatus).toBe('DEPLOYED');
  });

  it('F2: a non-DEPLOYED preview status (a usable URL that is still building) is copied into previewStatus', async () => {
    const h = await harness();
    const body = vercelBody([
      { name: 'grace-frontend-dev', projectId: 'p', rootDirectory: null, inspectorUrl: 'https://vercel.com/x', previewUrl: 'pending.example.com', nextCommitStatus: 'PENDING' },
    ]);
    h.gh.queueResponse({ stdout: JSON.stringify({ comments: [{ author: { login: 'vercel' }, body }] }) });
    const ctx = await h.service.briefContext(reviewSession(), 'review');
    expect(ctx.previewUrl).toBe('https://pending.example.com');
    expect(ctx.previewStatus).toBe('PENDING');
  });

  it('a develop stage carries the running local URL and no preview URL', async () => {
    const h = await harness();
    await h.service.start(devSession());
    const ctx = await h.service.briefContext(devSession(), 'develop');
    expect(ctx.localUrl).toBe('https://local.findcare.dev.aplaceformom.com');
    expect(ctx.localLogPath).toBe(DEV_LOG);
    expect(ctx.previewUrl).toBeNull();
    expect(h.gh.calls).toEqual([]);
  });

  it('a develop stage whose start failed carries the reason instead of a URL', async () => {
    const h = await harness();
    h.local.setPortListener(9999);
    await h.service.start(devSession());
    const ctx = await h.service.briefContext(devSession(), 'develop');
    expect(ctx.localUrl).toBeNull();
    expect(ctx.localUnavailableReason).toContain('the engine did not start');
  });

  it('an unconfigured repo renders nothing at all (R14)', async () => {
    const h = await harness();
    const session: Session = { ...reviewSession(), workspace: { repoUrl: 'https://github.com/aplaceformom/grace.git' } };
    expect(await h.service.briefContext(session, 'review')).toEqual(EMPTY_ENVIRONMENT);
    expect(h.gh.calls).toEqual([]);
  });
});
