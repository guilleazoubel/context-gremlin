/**
 * Phase 15 §3 — the two QA entry points, as the extension host actually sends them.
 *
 * `Verify in QA` is one POST that creates AND starts; `Ask about QA` is the same URL with
 * `start:false`, which creates the session, writes its brief and starts nothing — and then opens
 * the conversation on the session the engine just named. Both address the item by its MERGED
 * PR's path, because that is the `KeyedLock` key the automatic leg reserves under (E2/E9).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CoreClient } from '../../src/core-client';
import { createUi, type Ui } from '../../src/ui/wiring';
import { FakeHost } from '../support/fake-host';
import { FakeBridge, FakeEngineManager } from '../support/fake-engine-manager';
import { EngineSurface } from '../../src/ui/engine';
import { fixtures, startStubServer, type StubServerHandle } from '../support/stub-server';

const REPO = 'acme/web';
const ITEM = 'ticket:HB-900';
const SESSION = 'qa-web-HB-900-20260915';

const MERGED_ITEM = {
  id: ITEM, kind: 'pr+ticket', lists: ['myWork'], demoted: false, parkingLotGroup: null,
  title: 'HB-900 — the merged change',
  prs: [{
    repo: REPO, number: 900, url: `https://github.com/${REPO}/pull/900`, title: 'the merged change',
    author: 'guille', branch: 'feature/HB-900', isDraft: false, isMine: true, reviewDecision: null,
    humanActivity: null, reviewRequests: null, teamActivity: null, updatedAt: '2026-09-15T10:00:00Z',
    createdAt: '2026-09-10T10:00:00Z', changedFiles: 3, additions: 20, deletions: 1, ci: 'success',
    labels: null, sizeTier: 'S', state: 'merged',
  }],
  ticket: {
    key: 'HB-900', summary: 'the merged change', status: 'UAT', statusCategory: 'In Progress',
    url: 'https://jira.invalid/browse/HB-900', assignee: 'guille', updatedAt: '2026-09-14T10:00:00Z',
  },
  agents: [], needsYou: false, dismissed: false, dismissedAt: null,
  attention: { reasons: [], since: '2026-09-15T10:00:00.000Z', acked: false, refs: [] },
};

const ITEMS = {
  evaluatedAt: '2026-09-15T18:00:00.000Z',
  lists: { parkingLot: { reviewing: [], untouched: [], someoneOnIt: [] }, myWork: [ITEM], investigations: [], waitingForReview: [] },
  dismissed: [], items: [MERGED_ITEM],
  ticketSource: { kind: 'ok', error: null, scannedAt: null },
  threadSource: { error: null, scannedAt: null },
};

const servers: StubServerHandle[] = [];
const uis: Ui[] = [];

afterEach(async () => {
  for (const ui of uis.splice(0)) await ui.dispose();
  for (const server of servers.splice(0)) await server.dispose();
});

async function harness(): Promise<{ host: FakeHost; server: StubServerHandle; ui: Ui }> {
  const config = JSON.parse(JSON.stringify(fixtures.config)) as {
    config: Record<string, unknown>;
  };
  config.config.environments = { [REPO]: { qa: { url: 'https://qa.example.invalid' } } };
  const server = await startStubServer({
    handler: (req) => {
      if (req.method === 'GET' && req.path === '/config') return { status: 200, body: config };
      if (req.method === 'GET' && req.path === '/items') return { status: 200, body: ITEMS };
      if (req.method === 'POST' && req.path.endsWith('/agents')) {
        return { status: 202, body: { session: { id: SESSION }, created: true, started: true } };
      }
      return undefined;
    },
  });
  servers.push(server);
  const host = new FakeHost();
  const manager = new FakeEngineManager();
  manager.current = { kind: 'running', version: '0.0.1', pid: 10, adopted: false };
  const ui = createUi({
    host,
    client: new CoreClient(server.socketPath),
    notificationLevel: () => 'needs-you-only',
    engine: new EngineSurface({
      host, manager, bridge: new FakeBridge(),
      configPath: () => '/tmp/cgremlin-fixture/core.json', home: '/home/me',
      resolveLoginPath: async () => null, execPath: '/path/to/node',
      enginePath: '/ext/engine/engine.js', reconnect: async () => undefined,
    }),
    coalesceMs: 5,
    assets: {
      itemTab: { scriptText: '', styleText: '' },
      panel: { scriptText: '', styleText: '' },
      mediaPath: '/ext/media',
    },
  });
  uis.push(ui);
  host.resolveView('cgremlin.items').webview.emit({ type: 'ready' });
  expect(await ui.connect()).toBe(true);
  return { host, server, ui };
}

const posts = (server: StubServerHandle): { path: string; body: unknown }[] =>
  server.requests
    .filter((r) => r.method === 'POST' && r.path.endsWith('/agents'))
    .map((r) => ({ path: r.path, body: r.body }));

describe('§3 — Verify in QA', () => {
  it('creates and starts, addressed by the merged PR path', async () => {
    const { host, server } = await harness();
    await host.executeCommand('cgremlin.verifyInQa', ITEM);
    expect(posts(server)).toEqual([
      { path: '/items/pr/acme/web/900/agents', body: { mode: 'qa' } },
    ]);
  });
});

describe('§3/R73 — Ask about QA', () => {
  it('creates WITHOUT starting, then opens the conversation on that session', async () => {
    const { host, server } = await harness();
    await host.executeCommand('cgremlin.askQa', ITEM);
    expect(posts(server).map((p) => p.body)).toEqual([{ mode: 'qa', start: false }]);
    // R73's whole point: the conversation opens on the session the create just named.
    expect(host.terminals.length).toBe(1);
    expect(
      server.requests.some((r) => r.path === `/sessions/${SESSION}/conversation/claim`),
    ).toBe(true);
  });
});
