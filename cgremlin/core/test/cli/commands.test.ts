import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInventoryHarness, type InventoryHarness } from '../support/inventory-harness';
import { createApiServer } from '../../src/api/server';
import { SESSIONS_DIR } from '../support/pipeline-harness';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { resolveCoreConfig, writeCoreConfig } from '../../src/config/core-config';
import { defaultConfigPath, type CommandIO } from '../../src/cli/command-io';
import { prsCommand } from '../../src/cli/commands/prs';
import { reviewCommand } from '../../src/cli/commands/review';
import { sessionsCommand } from '../../src/cli/commands/sessions';
import { scanCommand } from '../../src/cli/commands/scan';

const HOME = '/home/cli-test';
const A_SHA = 'a'.repeat(40);
const B_SHA = 'b'.repeat(40);

function ownPrItem() {
  return {
    number: 5, url: 'https://github.com/acme/app/pull/5',
    author: { login: 'me-user', is_bot: false }, isDraft: false, reviewDecision: '',
    headRefOid: A_SHA, headRefName: 'feature-mine', baseRefName: 'main',
    title: 'My own PR', updatedAt: '2026-09-04T00:00:00.000Z',
    latestReviews: [], reviews: [], comments: [],
  };
}

function teamPrItem() {
  return {
    number: 7, url: 'https://github.com/acme/app/pull/7',
    author: { login: 'bob', is_bot: false }, isDraft: false, reviewDecision: '',
    headRefOid: B_SHA, headRefName: 'feature-bob', baseRefName: 'main',
    title: "Bob's PR", updatedAt: '2026-09-04T00:00:00.000Z',
    latestReviews: [], reviews: [], comments: [],
  };
}

function makeWriter() {
  const chunks: string[] = [];
  return { write: (s: string) => { chunks.push(s); }, text: () => chunks.join('') };
}

let dir: string;
let socketPath: string;
let server: http.Server;
let ih: InventoryHarness;
let cliFs: InMemoryFileSystem;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-cli-test-'));
  socketPath = path.join(dir, 'engine.sock');
  ih = createInventoryHarness();
  server = createApiServer({
    sessionStore: ih.h.store,
    workspaceManager: ih.h.workspace,
    pipeline: ih.h.service,
    fs: ih.h.fs,
    sessionsDir: SESSIONS_DIR,
    events: ih.h.events,
    inventory: { scanner: ih.scanner, scheduler: ih.scheduler, factory: ih.factory, inventoryStore: ih.inventoryStore, config: { me: ih.config.me } },
    lock: ih.lock,
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  cliFs = new InMemoryFileSystem();
  const config = resolveCoreConfig(
    { repos: ['acme/app'], me: 'me-user', socketPath, sessionsDir: '/x', worktreesDir: '/y', mirrorsDir: '/z', inventoryPath: '/inv.json' },
    HOME,
  );
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

describe('prs command', () => {
  it('exits 1 with a clear message when no scan has run yet', async () => {
    const { io, err } = testIo();
    const code = await prsCommand([], io);
    expect(code).toBe(1);
    expect(err()).toContain('no inventory scan has been run yet');
  });

  it('prints the grouped table after a scan (fixed-inventory snapshot)', async () => {
    ih.gh.queueResponse({ stdout: JSON.stringify([ownPrItem(), teamPrItem()]) });
    await ih.scanner.run();

    const { io, out } = testIo();
    const code = await prsCommand([], io);
    expect(code).toBe(0);
    expect(out()).toBe(
      'UNREVIEWED (1)\n' +
        "  #7  Bob's PR  bob  []\n" +
        '\n' +
        'MINE (1)\n' +
        '  #5  My own PR  me-user  []\n',
    );
  });

  it('--json prints the raw inventory/groups payload', async () => {
    ih.gh.queueResponse({ stdout: JSON.stringify([teamPrItem()]) });
    await ih.scanner.run();

    const { io, out } = testIo();
    const code = await prsCommand(['--json'], io);
    expect(code).toBe(0);
    const parsed = JSON.parse(out()) as { inventory: { entries: unknown[] }; groups: { unreviewed: unknown[] } };
    expect(parsed.inventory.entries).toHaveLength(1);
    expect(parsed.groups.unreviewed).toHaveLength(1);
  });
});

describe('review command', () => {
  it('exits 1 with the 409 message for a PR authored by the configured user', async () => {
    ih.gh.queueResponse({ stdout: JSON.stringify([ownPrItem()]) });
    await ih.scanner.run();

    const { io, err } = testIo();
    const code = await reviewCommand(['https://github.com/acme/app/pull/5'], io);
    expect(code).toBe(1);
    expect(err()).toContain('authored by the configured user');
  });

  it('starts a review for an eligible PR and prints the session id', async () => {
    ih.gh.queueResponse({ stdout: JSON.stringify([teamPrItem()]) });
    await ih.scanner.run();
    ih.gh.queueResponse({ stdout: JSON.stringify({
      number: 7, title: "Bob's PR", author: { login: 'bob' }, headRefName: 'feature-bob', headRefOid: B_SHA,
      baseRefName: 'main', url: 'https://github.com/acme/app/pull/7', state: 'OPEN', isDraft: false,
      reviewDecision: '', mergedAt: null, closedAt: null, latestReviews: [], statusCheckRollup: [],
    }) });

    const { io, out } = testIo();
    const code = await reviewCommand(['https://github.com/acme/app/pull/7'], io);
    expect(code).toBe(0);
    expect(out()).toMatch(/^(Created and started|Started) review session pr-app-7-/);
  });

  it('exits 2 with usage when no pr-url is given', async () => {
    const { io, err } = testIo();
    const code = await reviewCommand([], io);
    expect(code).toBe(2);
    expect(err()).toContain('Usage:');
  });
});

describe('sessions command', () => {
  it('prints "No sessions." when there are none', async () => {
    const { io, out } = testIo();
    const code = await sessionsCommand([], io);
    expect(code).toBe(0);
    expect(out()).toBe('No sessions.\n');
  });

  it('lists sessions after one is created', async () => {
    await ih.h.service.createInvestigationSession({
      repoUrl: 'git@github.com:acme/app.git', ticket: 'APP-1', intent: 'investigate_only', driveToCompletion: false,
    });
    const { io, out } = testIo();
    const code = await sessionsCommand([], io);
    expect(code).toBe(0);
    expect(out()).toContain('investigation  findings  lastRun=none');
  });
});

describe('scan command', () => {
  it('runs a scan and prints a summary', async () => {
    ih.gh.queueResponse({ stdout: JSON.stringify([teamPrItem()]) });
    const { io, out } = testIo();
    const code = await scanCommand([], io);
    expect(code).toBe(0);
    expect(out()).toContain('1 PR(s)');
    expect(out()).toContain('0 error(s)');
  });
});
