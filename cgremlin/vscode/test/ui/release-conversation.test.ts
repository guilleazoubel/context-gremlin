/**
 * Defect 3, the click — and the refusal that used to be a dead end.
 *
 * The user opened Chat (which claims the conversation for ten minutes) and clicked `Continue to
 * plan` forty-three seconds later. The engine answered, correctly,
 * `Session '…': a human holds the agent conversation; release it before running a stage`, and the
 * panel showed that sentence and stopped: `POST /sessions/:id/conversation/release` existed and
 * no button in the extension had ever called it.
 *
 * A refusal that names the way through must OFFER it. The lock is untouched — the engine still
 * refuses, and a claim somebody else is holding is refused just the same; what changed is that
 * the sentence now arrives with the button that clears it, and the verb the user was refused is
 * then re-sent rather than left for them to find again.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CoreClient } from '../../src/core-client';
import { createUi, type Ui } from '../../src/ui/wiring';
import { FakeHost } from '../support/fake-host';
import { FakeBridge, FakeEngineManager } from '../support/fake-engine-manager';
import { EngineSurface } from '../../src/ui/engine';
import { fixtures, startStubServer, type StubServerHandle } from '../support/stub-server';

const ITEM = 'session:inv-grace-claimed';
const SESSION = 'inv-grace-claimed';
const CLAIM_REFUSAL = `Session '${SESSION}': a human holds the agent conversation; release it before running a stage`;
const RELEASE = 'Release the conversation';

const CLAIMED_ITEM = {
  id: ITEM, kind: 'session', lists: ['investigations'], demoted: false, parkingLotGroup: null,
  title: SESSION,
  prs: [], ticket: null,
  agents: [
    {
      sessionId: SESSION, mode: 'investigation', phase: 'findings', running: false, claimed: true,
      runFailed: true, needsYou: false, primaryArtifact: 'FINDINGS.md',
      worktreePath: `/tmp/wt/${SESSION}`, ref: ITEM,
    },
  ],
  needsYou: false, dismissed: false, dismissedAt: null,
  attention: { reasons: [], since: '2026-09-22T13:50:00.000Z', acked: false, refs: [ITEM] },
};

const ITEMS = {
  evaluatedAt: '2026-09-22T14:00:00.000Z',
  lists: { parkingLot: { reviewing: [], untouched: [], someoneOnIt: [] }, myWork: [], investigations: [ITEM], waitingForReview: [] },
  dismissed: [], items: [CLAIMED_ITEM],
  ticketSource: { kind: 'ok', error: null, scannedAt: null },
  threadSource: { error: null, scannedAt: null },
};

const servers: StubServerHandle[] = [];
const uis: Ui[] = [];

afterEach(async () => {
  for (const ui of uis.splice(0)) await ui.dispose();
  for (const server of servers.splice(0)) await server.dispose();
});

const RELEASE_PATH = `/sessions/${SESSION}/conversation/release`;
const RUN_PATH = `/sessions/${SESSION}/run`;

/** `held` flips to false once the release lands, exactly as the engine's own `isClaimed` would. */
async function harness(opts: { refusal?: string } = {}): Promise<{ host: FakeHost; server: StubServerHandle }> {
  let held = true;
  const server = await startStubServer({
    handler: (req) => {
      if (req.method === 'GET' && req.path === '/config') return { status: 200, body: fixtures.config };
      if (req.method === 'GET' && req.path === '/items') return { status: 200, body: ITEMS };
      if (req.method === 'POST' && req.path === RELEASE_PATH) {
        held = false;
        return { status: 200, body: { ok: true } };
      }
      if (req.method === 'POST' && req.path === RUN_PATH) {
        return held
          ? { status: 409, body: { error: opts.refusal ?? CLAIM_REFUSAL } }
          : { status: 202, body: { ok: true } };
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
    assets: { itemTab: { scriptText: '', styleText: '' }, panel: { scriptText: '', styleText: '' }, mediaPath: '/ext/media' },
  });
  uis.push(ui);
  host.resolveView('cgremlin.items').webview.emit({ type: 'ready' });
  expect(await ui.connect()).toBe(true);
  return { host, server };
}

const countOf = (server: StubServerHandle, path: string): number =>
  server.requests.filter((r) => r.method === 'POST' && r.path === path).length;

describe('the release verb', () => {
  it('POSTs the one route that clears a claim, at the session the row named', async () => {
    const { host, server } = await harness();
    await host.executeCommand('cgremlin.releaseConversation', ITEM, `agent:${SESSION}`);
    expect(countOf(server, RELEASE_PATH)).toBe(1);
  });
});

describe('a stage refused for a held claim offers the release', () => {
  it('shows the engine’s own sentence WITH the button that clears it, then re-sends the verb', async () => {
    const { host, server } = await harness();
    host.messageAnswers = [RELEASE];
    await host.executeCommand('cgremlin.continueToPlan', ITEM, `agent:${SESSION}`);
    const asked = host.callsOf('showWarningMessage');
    expect(asked[0].args[0]).toBe(CLAIM_REFUSAL);
    expect(asked[0].args[2]).toContain(RELEASE);
    expect(countOf(server, RELEASE_PATH)).toBe(1);
    // Once, refused; once more, after the release — the user does not hunt for their verb again.
    expect(countOf(server, RUN_PATH)).toBe(2);
  });

  it('does nothing further when the offer is declined — the claim is still theirs to keep', async () => {
    const { host, server } = await harness();
    host.messageAnswers = [undefined];
    await host.executeCommand('cgremlin.continueToPlan', ITEM, `agent:${SESSION}`);
    expect(countOf(server, RELEASE_PATH)).toBe(0);
    expect(countOf(server, RUN_PATH)).toBe(1);
  });

  it('never offers a release for a refusal that is about something else', async () => {
    const { host, server } = await harness({ refusal: 'a stage run is already in progress' });
    host.messageAnswers = [RELEASE];
    await host.executeCommand('cgremlin.continueToPlan', ITEM, `agent:${SESSION}`);
    const asked = host.callsOf('showWarningMessage');
    expect(asked[0].args[2]).toEqual([]);
    expect(countOf(server, RELEASE_PATH)).toBe(0);
  });
});
