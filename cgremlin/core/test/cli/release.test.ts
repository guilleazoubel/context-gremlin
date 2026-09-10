import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiServer } from '../../src/api/server';
import { createHarness, SESSIONS_DIR, WORKTREES_DIR, type PipelineHarness } from '../support/pipeline-harness';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { resolveCoreConfig, writeCoreConfig } from '../../src/config/core-config';
import { defaultConfigPath, type CommandIO } from '../../src/cli/command-io';
import { releaseCommand } from '../../src/cli/commands/release';
import { sessionsCommand } from '../../src/cli/commands/sessions';
import { main } from '../../src/cli/main';
import type { Session } from '../../src/schema/session';

const HOME = '/home/cli-release-test';
// The CLI's `claimed` column is computed against the REAL clock (it is a
// client, with no clock seam), so a "live" claim here must be live now.
const LIVE = {
  claimedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
};
const EXPIRED = { claimedAt: '2026-09-04T10:00:00.000Z', expiresAt: '2026-09-04T10:10:00.000Z' };

function makeWriter() {
  const chunks: string[] = [];
  return { write: (s: string) => { chunks.push(s); }, text: () => chunks.join('') };
}

function devSession(id: string, humanTurn: typeof LIVE | null): Session {
  return {
    schemaVersion: 2, id, mode: 'development', createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath: `${WORKTREES_DIR}/${id}`, branch: 'feature/x' },
    lineage: { pipelineId: id, parentSessionId: null, ticket: 'APP-1' },
    stageStatus: 'active',
    agent: { runner: 'claude-code', resumeId: 'resume-1', humanTurn },
    lastRun: null, pr: null,
  };
}

let dir: string;
let socketPath: string;
let server: http.Server;
let h: PipelineHarness;
let cliFs: InMemoryFileSystem;
let stdout: ReturnType<typeof makeWriter>;
let stderr: ReturnType<typeof makeWriter>;
let io: CommandIO;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-release-test-'));
  socketPath = path.join(dir, 'engine.sock');
  h = createHarness();
  server = createApiServer({
    sessionStore: h.store,
    workspaceManager: h.workspace,
    pipeline: h.service,
    fs: h.fs,
    sessionsDir: SESSIONS_DIR,
    events: h.events,
    lock: h.lock,
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  cliFs = new InMemoryFileSystem();
  await writeCoreConfig(
    cliFs,
    defaultConfigPath(HOME),
    resolveCoreConfig({ repos: ['acme/app'], me: 'me-user', socketPath }, HOME),
    { force: true },
  );
  stdout = makeWriter();
  stderr = makeWriter();
  io = { stdout, stderr, home: HOME, fs: cliFs };
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe('cgremlin-core release <session-id>', () => {
  it('releases the claim through POST /sessions/:id/conversation/release and says so', async () => {
    await h.store.save(devSession('dev-1', LIVE));
    expect(await releaseCommand(['dev-1'], io)).toBe(0);
    expect(stdout.text()).toContain('dev-1');
    expect((await h.store.load('dev-1')).agent?.humanTurn).toBeNull();
  });

  it('is idempotent on an already-released session', async () => {
    await h.store.save(devSession('dev-2', null));
    expect(await releaseCommand(['dev-2'], io)).toBe(0);
  });

  it('prints the engine error and exits 1 for an unknown session', async () => {
    expect(await releaseCommand(['nope'], io)).toBe(1);
    expect(stderr.text()).toMatch(/No session found with id 'nope'.*404/);
  });

  it('requires a session id', async () => {
    expect(await releaseCommand([], io)).toBe(2);
    expect(stderr.text()).toContain('Usage: cgremlin-core release <session-id>');
  });

  it('is registered on the CLI dispatcher and in the usage text', async () => {
    await h.store.save(devSession('dev-3', LIVE));
    expect(await main(['release', 'dev-3'], io)).toBe(0);
    expect((await h.store.load('dev-3')).agent?.humanTurn).toBeNull();
    const usage = makeWriter();
    await main(['--help'], { ...io, stdout: usage });
    expect(usage.text()).toContain('release <session-id>');
  });
});

describe('cgremlin-core sessions — the claimed column (R20)', () => {
  it('--json carries claimed: true for a live claim and false for an expired one', async () => {
    await h.store.save(devSession('dev-live', LIVE));
    await h.store.save(devSession('dev-expired', EXPIRED));
    await h.store.save(devSession('dev-none', null));
    expect(await sessionsCommand(['--json'], io)).toBe(0);
    const body = JSON.parse(stdout.text()) as { sessions: Array<Session & { claimed: boolean }> };
    expect(body.sessions.map((s) => [s.id, s.claimed])).toEqual([
      ['dev-expired', false],
      ['dev-live', true],
      ['dev-none', false],
    ]);
  });

  it('the table shows claimed for each session', async () => {
    await h.store.save(devSession('dev-live', LIVE));
    await h.store.save(devSession('dev-none', null));
    expect(await sessionsCommand([], io)).toBe(0);
    const lines = stdout.text().trim().split('\n');
    expect(lines[0]).toContain('claimed=true');
    expect(lines[1]).toContain('claimed=false');
  });
});
