/**
 * Defect 4, the host half — a `run.output` frame is the ONE frame read as content.
 *
 * Every other frame is an address: the consumer refetches and renders from the fresh read, so two
 * engines' answers can never disagree (R41). `run.output` has nothing to refetch — the output
 * exists only as it streams — which is exactly why the pane can never be the record, and why the
 * exception is written beside R41 itself rather than only here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CoreClient } from '../../src/core-client';
import { createUi, type Ui } from '../../src/ui/wiring';
import { FakeHost } from '../support/fake-host';
import { FakeBridge, FakeEngineManager } from '../support/fake-engine-manager';
import { EngineSurface } from '../../src/ui/engine';
import { fixtures, startStubServer, type StubServerHandle } from '../support/stub-server';

const SESSION = 'inv-grace-plan';
const ITEM = `session:${SESSION}`;

const RUNNING_ITEM = {
  id: ITEM, kind: 'session', lists: ['investigations'], demoted: false, parkingLotGroup: null,
  title: SESSION, prs: [], ticket: null,
  agents: [
    {
      sessionId: SESSION, mode: 'investigation', phase: 'plan', running: true, claimed: false,
      runFailed: false, needsYou: false, primaryArtifact: null,
      worktreePath: null, ref: ITEM,
      lastRun: { stage: 'plan', startedAt: '2026-09-22T13:52:00.000Z' },
    },
  ],
  needsYou: false, dismissed: false, dismissedAt: null,
  attention: { reasons: [], since: '2026-09-22T13:52:00.000Z', acked: false, refs: [ITEM] },
};

const ITEMS = {
  evaluatedAt: '2026-09-22T14:00:00.000Z',
  lists: { parkingLot: { reviewing: [], untouched: [], someoneOnIt: [] }, myWork: [], investigations: [ITEM], waitingForReview: [] },
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

async function harness(): Promise<{ host: FakeHost; ui: Ui; renegotiations: number[] }> {
  const server = await startStubServer({
    handler: (req) => {
      if (req.method === 'GET' && req.path === '/config') return { status: 200, body: fixtures.config };
      if (req.method === 'GET' && req.path === '/items') return { status: 200, body: ITEMS };
      if (req.method === 'GET' && req.path === `/items/session/${SESSION}`) {
        return {
          status: 200,
          body: { item: RUNNING_ITEM, ticket: null, ticketError: null, artifacts: { [SESSION]: [] } },
        };
      }
      if (req.method === 'GET' && req.path === `/sessions/${SESSION}/artifacts`) {
        return { status: 200, body: { artifacts: [] } };
      }
      return undefined;
    },
  });
  servers.push(server);
  const host = new FakeHost();
  const manager = new FakeEngineManager();
  manager.current = { kind: 'running', version: '0.0.1', pid: 10, adopted: false };
  const renegotiations: number[] = [];
  const ui = createUi({
    host,
    client: new CoreClient(server.socketPath),
    notificationLevel: () => 'needs-you-only',
    onWatchChanged: () => renegotiations.push(1),
    engine: new EngineSurface({
      host, manager, bridge: new FakeBridge(),
      configPath: () => '/tmp/cgremlin-fixture/core.json', home: '/home/me',
      resolveLoginPath: async () => null, execPath: '/path/to/node',
      enginePath: '/ext/engine/engine.js', reconnect: async () => undefined,
    }),
    coalesceMs: 5,
    assets: { itemTab: { scriptText: '', styleText: '' }, panel: { scriptText: '', styleText: '' }, mediaPath: '/ext/media' },
  });
  uis.push(ui);
  host.resolveView('cgremlin.items').webview.emit({ type: 'ready' });
  expect(await ui.connect()).toBe(true);
  return { host, ui, renegotiations };
}

const frame = (event: string, data: unknown): unknown => ({ id: 1, event, data });

describe('watching a live run', () => {
  it('opens a buffer, asks for a renegotiation, and streams what arrives into it', async () => {
    const { ui, renegotiations } = await harness();
    await ui.itemTab.open(`session/${SESSION}`);
    expect(ui.itemTab.watching()).toBe(false);

    await ui.itemTab.watchRun(SESSION);
    expect(ui.itemTab.watching()).toBe(true);
    expect(renegotiations).toHaveLength(1);
    // Joined a run that was ALREADY live: the beginning is gone and the pane must say so.
    expect(ui.itemTab.runOutputOf(SESSION)?.joinedMidRun).toBe(true);

    ui.handleFrame(frame('run.output', { sessionId: SESSION, stage: 'plan', chunk: { stream: 'stdout', data: 'thinking…\n' } }));
    expect(ui.itemTab.runOutputOf(SESSION)?.lines).toEqual(['thinking…']);
  });

  it('ignores output for a session nobody is watching', async () => {
    const { ui } = await harness();
    await ui.itemTab.open(`session/${SESSION}`);
    ui.handleFrame(frame('run.output', { sessionId: SESSION, stage: 'plan', chunk: { stream: 'stdout', data: 'noise\n' } }));
    expect(ui.itemTab.runOutputOf(SESSION)).toBeNull();
  });

  it('freezes the pane when the run finishes underneath it, naming the outcome', async () => {
    const { ui } = await harness();
    await ui.itemTab.open(`session/${SESSION}`);
    await ui.itemTab.watchRun(SESSION);
    ui.handleFrame(frame('run.output', { sessionId: SESSION, stage: 'plan', chunk: { stream: 'stdout', data: 'last line\n' } }));
    ui.handleFrame(frame('run.finished', { session: { id: SESSION }, stage: 'plan', outcome: 'succeeded' }));
    const view = ui.itemTab.runOutputOf(SESSION);
    expect(view?.state).toBe('ended');
    expect(view?.ending).toContain('succeeded');
    expect(view?.lines).toEqual(['last line']);
    // A pane that has stopped is no longer a reason to keep the high-volume include on.
    expect(ui.itemTab.watching()).toBe(false);
  });

  it('drops the buffer when the tab closes, and renegotiates back down', async () => {
    const { ui, renegotiations } = await harness();
    await ui.itemTab.open(`session/${SESSION}`);
    await ui.itemTab.watchRun(SESSION);
    ui.itemTab.dispose();
    expect(ui.itemTab.runOutputOf(SESSION)).toBeNull();
    expect(ui.itemTab.watching()).toBe(false);
    expect(renegotiations.length).toBeGreaterThan(1);
  });
});
