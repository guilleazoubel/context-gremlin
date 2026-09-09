import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiServer } from '../../src/api/server';
import { EnvironmentService, type LocalAppStatus } from '../../src/env/environment-service';
import { resolveCoreConfig, writeCoreConfig, type CoreConfig } from '../../src/config/core-config';
import { defaultConfigPath, type CommandIO } from '../../src/cli/command-io';
import { formatLocalStatus, localCommand } from '../../src/cli/commands/local';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { FakeGhRunner } from '../support/fake-gh-runner';
import { FakeLocalAppRunner } from '../support/fake-local-app-runner';
import { createHarness, SESSIONS_DIR, type PipelineHarness } from '../support/pipeline-harness';
import type { Session } from '../../src/schema/session';

const HOME = '/home/cli-local';
const REPO_URL = 'https://github.com/acme/app.git';
const WT = '/worktrees/s1';
const APP_URL = 'https://local.example.test';

function makeConfig(socketPath: string): CoreConfig {
  return resolveCoreConfig(
    {
      repos: ['acme/app'],
      me: 'me-user',
      socketPath,
      environments: {
        'acme/app': { localApp: { url: APP_URL, port: 8080, stages: ['develop'] } },
      },
    },
    HOME,
  );
}

function devSession(id: string): Session {
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
    pr: null,
  };
}

function makeWriter() {
  const chunks: string[] = [];
  return { write: (s: string) => { chunks.push(s); }, text: () => chunks.join('') };
}

let dir: string;
let socketPath: string;
let server: http.Server;
let h: PipelineHarness;
let local: FakeLocalAppRunner;
let cliFs: InMemoryFileSystem;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-cli-local-'));
  socketPath = path.join(dir, 'engine.sock');
  local = new FakeLocalAppRunner();
  const gh = new FakeGhRunner();
  const config = makeConfig(socketPath);
  h = createHarness({
    environment: ({ fs, git, lock }) =>
      new EnvironmentService({
        fs, gh, git, local, config,
        sessionsDir: SESSIONS_DIR,
        statePath: config.localAppStatePath!,
        lock,
        env: { HOME },
      }),
  });
  await h.fs.mkdir(WT, { recursive: true });
  await h.fs.writeFile(`${WT}/package.json`, JSON.stringify({ scripts: { dev: 'next dev' } }));
  await h.fs.writeFile(`${WT}/.env.local`, 'A=1\n');
  await h.fs.mkdir(`${WT}/node_modules`, { recursive: true });
  await h.store.save(devSession('s1'));

  server = createApiServer({
    sessionStore: h.store,
    workspaceManager: h.workspace,
    pipeline: h.service,
    fs: h.fs,
    sessionsDir: SESSIONS_DIR,
    events: h.events,
    lock: h.lock,
    environment: h.environment,
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  cliFs = new InMemoryFileSystem();
  await writeCoreConfig(cliFs, defaultConfigPath(HOME), config, { force: true });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

function testIo(): { io: CommandIO; out: () => string; err: () => string } {
  const stdout = makeWriter();
  const stderr = makeWriter();
  return { io: { stdout, stderr, home: HOME, fs: cliFs }, out: stdout.text, err: stderr.text };
}

describe('formatLocalStatus', () => {
  const base: LocalAppStatus = {
    state: 'stopped', sessionId: null, url: null, pid: null,
    logPath: null, startedAt: null, reason: null, logTail: null,
  };

  it('renders stopped, running and unavailable in the documented one-line forms', () => {
    expect(formatLocalStatus(base)).toBe('stopped');
    expect(
      formatLocalStatus({ ...base, state: 'running', sessionId: 's1', url: APP_URL, pid: 1234 }),
    ).toBe(`running s1 ${APP_URL} pid 1234`);
    expect(formatLocalStatus({ ...base, state: 'unavailable', reason: 'port 8080 is busy' })).toBe(
      'unavailable — port 8080 is busy',
    );
  });
});

describe('local command', () => {
  it('local status prints stopped when nothing is running', async () => {
    const { io, out } = testIo();
    expect(await localCommand(['status'], io)).toBe(0);
    expect(out()).toBe('stopped\n');
  });

  it('local start <session> starts the app and prints the running line', async () => {
    const { io, out } = testIo();
    expect(await localCommand(['start', 's1'], io)).toBe(0);
    expect(out()).toBe(`running s1 ${APP_URL} pid 1234\n`);
    expect(local.startCalls).toHaveLength(1);
  });

  it('local status reflects the running app and --json emits the raw status', async () => {
    await localCommand(['start', 's1'], testIo().io);

    const plain = testIo();
    expect(await localCommand(['status'], plain.io)).toBe(0);
    expect(plain.out()).toBe(`running s1 ${APP_URL} pid 1234\n`);

    const json = testIo();
    expect(await localCommand(['status', '--json'], json.io)).toBe(0);
    const parsed = JSON.parse(json.out()) as LocalAppStatus;
    expect(parsed).toMatchObject({ state: 'running', sessionId: 's1', url: APP_URL, pid: 1234 });
  });

  it('local start exits 1 with the reason on stderr when the API answers 409', async () => {
    local.setPortListener(4242);
    const { io, err } = testIo();
    expect(await localCommand(['start', 's1'], io)).toBe(1);
    expect(err()).toContain('port 8080 is held by pid 4242');
    expect(err()).toContain('HTTP 409');
  });

  it('local stop with no argument stops the current owner', async () => {
    await localCommand(['start', 's1'], testIo().io);
    const { io, out } = testIo();
    expect(await localCommand(['stop'], io)).toBe(0);
    expect(out()).toBe('stopped\n');
    expect(local.stopCalls).toHaveLength(1);
  });

  it('local stop <session> that is not the owner leaves the app running', async () => {
    await h.store.save(devSession('s2'));
    await localCommand(['start', 's1'], testIo().io);
    const { io, out } = testIo();
    expect(await localCommand(['stop', 's2'], io)).toBe(0);
    expect(out()).toBe(`running s1 ${APP_URL} pid 1234\n`);
    expect(local.stopCalls).toHaveLength(0);
  });

  it('local start with no session id exits 2 with usage', async () => {
    const { io, err } = testIo();
    expect(await localCommand(['start'], io)).toBe(2);
    expect(err()).toContain('local start <session-id>');
  });

  it('an unknown local subcommand exits 2', async () => {
    const { io, err } = testIo();
    expect(await localCommand(['bogus'], io)).toBe(2);
    expect(err()).toContain('Unknown local subcommand');
  });
});
