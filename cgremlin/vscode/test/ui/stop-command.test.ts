/**
 * Phase 19 — `Stop`, the way forward while an agent works. The row's rule table (`row-actions.ts`)
 * offers the verb only beside a disabled, busy Chat; this is the click itself: a MODAL confirm
 * that names the consequence exactly, then — and only on confirm — the existing
 * `POST /sessions/:id/stop` through `CoreClient.stop`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CoreClient } from '../../src/core-client';
import { createUi, type Ui } from '../../src/ui/wiring';
import { FakeHost } from '../support/fake-host';
import { FakeBridge, FakeEngineManager } from '../support/fake-engine-manager';
import { EngineSurface } from '../../src/ui/engine';
import { fixtures, startStubServer, type StubServerHandle } from '../support/stub-server';

const ITEM = 'ticket:HB-900';
const SESSION = 'dev-HB-900-20260915';

const RUNNING_ITEM = {
  id: ITEM, kind: 'ticket', lists: ['myWork'], demoted: false, parkingLotGroup: null,
  title: 'HB-900 — a run in flight',
  prs: [],
  ticket: {
    key: 'HB-900', summary: 'a run in flight', status: 'In Progress', statusCategory: 'In Progress',
    url: 'https://jira.invalid/browse/HB-900', assignee: 'guille', updatedAt: '2026-09-14T10:00:00Z',
  },
  agents: [
    {
      sessionId: SESSION, mode: 'development', phase: 'coding', running: true, claimed: true,
      runFailed: false, needsYou: false,
    },
  ],
  needsYou: false, dismissed: false, dismissedAt: null,
  attention: { reasons: [], since: '2026-09-15T10:00:00.000Z', acked: false, refs: [] },
};

const ITEMS = {
  evaluatedAt: '2026-09-15T18:00:00.000Z',
  lists: { parkingLot: { reviewing: [], untouched: [], someoneOnIt: [] }, myWork: [ITEM], investigations: [], waitingForReview: [] },
  dismissed: [], items: [RUNNING_ITEM],
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
  const server = await startStubServer({
    handler: (req) => {
      if (req.method === 'GET' && req.path === '/config') return { status: 200, body: fixtures.config };
      if (req.method === 'GET' && req.path === '/items') return { status: 200, body: ITEMS };
      if (req.method === 'POST' && req.path === `/sessions/${SESSION}/stop`) {
        return { status: 200, body: { ok: true } };
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

const stops = (server: StubServerHandle): number =>
  server.requests.filter((r) => r.method === 'POST' && r.path === `/sessions/${SESSION}/stop`).length;

describe('cgremlin.stop — the modal confirm', () => {
  it('shows a modal naming the exact consequence, and on confirm calls stop once with the right session', async () => {
    const { host, server } = await harness();
    host.messageAnswers = ['Stop the run'];
    await host.executeCommand('cgremlin.stop', ITEM, `agent:${SESSION}`);
    const asked = host.callsOf('showWarningMessage');
    expect(asked.length).toBe(1);
    expect(asked[0].args[0]).toBe(
      "This ends the agent's current run. Work it already wrote to files is kept.",
    );
    expect(asked[0].args[1]).toEqual({ modal: true });
    expect(stops(server)).toBe(1);
  });

  it('calls stop nothing when the modal is cancelled', async () => {
    const { host, server } = await harness();
    host.messageAnswers = [undefined];
    await host.executeCommand('cgremlin.stop', ITEM, `agent:${SESSION}`);
    expect(stops(server)).toBe(0);
  });
});
