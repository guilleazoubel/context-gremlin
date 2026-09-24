/**
 * The config the extension never read.
 *
 * `RefreshCoordinator.config()` is assigned in exactly one place — `connect()` — so a first
 * connect that failed (the engine restart that follows installing a new build) left it `null`
 * forever. Every reader then degraded to an empty answer, and the repo picker reported that
 * empty answer as a fact about the user's `core.json`: "No repos are configured in core.json."
 * said to a user whose config lists two, on an engine that was answering `GET /config`.
 *
 * These tests pin both halves: the coordinator fetches a config it never got rather than
 * latching on the startup failure, and the picker says a different, true thing in each case.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CoreClient } from '../../src/core-client';
import { createUi, type Ui } from '../../src/ui/wiring';
import { NO_REPOS_MESSAGE, REPOS_UNREADABLE_MESSAGE } from '../../src/ui/commands';
import { WORKSPACE_UNREADABLE_MESSAGE } from '../../src/ui/preview';
import { FakeHost } from '../support/fake-host';
import { FakeBridge, FakeEngineManager } from '../support/fake-engine-manager';
import { EngineSurface } from '../../src/ui/engine';
import {
  fixtures,
  startStubServer,
  type StubHandler,
  type StubServerHandle,
} from '../support/stub-server';

const STATE_DIR = '/tmp/cgremlin-fixture';

const servers: StubServerHandle[] = [];
const uis: Ui[] = [];

afterEach(async () => {
  for (const ui of uis.splice(0)) await ui.dispose();
  for (const server of servers.splice(0)) await server.dispose();
});

interface Harness {
  host: FakeHost;
  server: StubServerHandle;
  ui: Ui;
  configReads(): number;
}

async function harness(handler?: StubHandler): Promise<Harness> {
  const server = await startStubServer({ handler });
  servers.push(server);
  const host = new FakeHost();
  const engine = new FakeEngineManager();
  engine.current = { kind: 'running', version: '0.0.1', pid: 10, adopted: false };
  const surface = new EngineSurface({
    host,
    manager: engine,
    bridge: new FakeBridge(),
    configPath: () => `${STATE_DIR}/core.json`,
    home: '/home/me',
    resolveLoginPath: async () => null,
    execPath: '/path/to/node',
    enginePath: '/ext/engine/engine.js',
    reconnect: async () => undefined,
  });
  const ui = createUi({
    host,
    client: new CoreClient(server.socketPath),
    notificationLevel: () => 'needs-you-only',
    engine: surface,
    coalesceMs: 5,
    assets: {
      itemTab: { scriptText: '', styleText: '' },
      panel: { scriptText: '', styleText: '' },
      mediaPath: '/ext/media',
    },
  });
  uis.push(ui);
  const view = host.resolveView('cgremlin.items');
  view.webview.emit({ type: 'ready' });
  return {
    host,
    server,
    ui,
    configReads: () => server.requests.filter((r) => r.path === '/config').length,
  };
}

/** The user's situation: the engine was mid-restart when the window activated. */
async function connectDuringRestart(h: Harness): Promise<void> {
  await h.server.stop();
  expect(await h.ui.connect()).toBe(false);
  await h.server.restart();
}

const emptyRepos: StubHandler = (req) => {
  if (req.method === 'GET' && req.path === '/config') {
    const base = (fixtures.config as { config: Record<string, unknown> }).config;
    return { status: 200, body: { config: { ...base, repos: [] } } };
  }
  return undefined;
};

function lastWarning(host: FakeHost): string {
  const calls = host.callsOf('showWarningMessage');
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1].args[0] as string;
}

describe('a coordinator whose first connect failed', () => {
  it('fetches the config it never got rather than answering with nothing', async () => {
    const h = await harness();
    await connectDuringRestart(h);
    // What it HAS is nothing — and that is not the same as a config that lists no repos.
    expect(h.ui.coordinator.config()).toBeNull();

    const config = await h.ui.coordinator.ensureConfig();
    expect(config?.repos).toEqual(['acme/web', 'acme/api']);
    // And the value is kept: the next reader gets it without another round trip.
    expect(h.ui.coordinator.config()?.repos).toEqual(['acme/web', 'acme/api']);
  });

  it('shares one fetch between concurrent callers', async () => {
    const h = await harness();
    const before = h.configReads();
    const [a, b, c] = await Promise.all([
      h.ui.coordinator.ensureConfig(),
      h.ui.coordinator.ensureConfig(),
      h.ui.coordinator.ensureConfig(),
    ]);
    expect(h.configReads() - before).toBe(1);
    expect(a?.repos).toEqual(['acme/web', 'acme/api']);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('answers the caller when the fetch fails, instead of hanging or throwing', async () => {
    const h = await harness();
    await h.server.stop();
    const hung = Symbol('hung');
    const answer = await Promise.race([
      h.ui.coordinator.ensureConfig(),
      new Promise((resolve) => setTimeout(() => resolve(hung), 1_000)),
    ]);
    expect(answer).toBeNull();
    // And it does not latch on the failure either: the engine comes back, the next ask works.
    await h.server.restart();
    expect((await h.ui.coordinator.ensureConfig())?.repos).toEqual(['acme/web', 'acme/api']);
  });
});

describe('the repo picker distinguishes the two empty answers', () => {
  it('names core.json only when it has the config and the config lists no repos', async () => {
    const h = await harness(emptyRepos);
    expect(await h.ui.connect()).toBe(true);
    await h.host.executeCommand('cgremlin.newInvestigation');
    expect(lastWarning(h.host)).toBe(NO_REPOS_MESSAGE);
    expect(h.host.callsOf('showQuickPick')).toEqual([]);
  });

  it('talks about reaching the engine, and offers the way through, when it has no config', async () => {
    const h = await harness();
    await h.server.stop();
    expect(await h.ui.connect()).toBe(false);
    h.host.messageAnswers = ['Start the engine'];
    await h.host.executeCommand('cgremlin.newInvestigation');

    const warning = h.host.callsOf('showWarningMessage').at(-1);
    expect(warning?.args[0]).toBe(REPOS_UNREADABLE_MESSAGE);
    expect(warning?.args[0]).not.toContain('core.json');
    // The way through, not a blamed file: the button starts the engine the message is about.
    expect(warning?.args[2]).toEqual(['Start the engine']);
    expect(
      h.host.callsOf('executeCommand').some((c) => c.args[0] === 'cgremlin.engine.start'),
    ).toBe(true);
    expect(h.host.callsOf('showQuickPick')).toEqual([]);
  });
});

/**
 * The reported scenario end to end: install a new build, the engine restarts, the window's first
 * connect lands in that gap, the engine is healthy seconds later — and the user starts an
 * investigation.
 */
it('offers both repos to an investigation started after a failed first connect', async () => {
  const h = await harness();
  await connectDuringRestart(h);

  h.host.quickPickAnswers = [undefined];
  await h.host.executeCommand('cgremlin.newInvestigation');

  const pick = h.host.callsOf('showQuickPick')[0];
  expect(pick?.args[0]).toEqual(['acme/web', 'acme/api']);
  expect(h.host.callsOf('showWarningMessage')).toEqual([]);
});

/**
 * The sweep. Every other reader of `config()` degraded to an empty answer in the same window,
 * and the two that reach the workspace did it silently: a row click that swapped nothing, and a
 * command that opened nothing. Both of them can wait for a fetch, so both of them ask for one.
 */
describe('the other readers of a config that was never read', () => {
  it('heals the render-time readers on the first refresh that reaches the engine', async () => {
    const h = await harness();
    await connectDuringRestart(h);
    await h.ui.coordinator.refreshNow();
    // `me` is the one that makes the panel quietly wrong rather than visibly broken: without it
    // the user's own review is listed as somebody else's.
    expect(h.ui.coordinator.config()?.me).toBe('guille');
    expect(h.configReads()).toBe(1);
  });

  it('opens the managed workspace for a window whose first connect failed', async () => {
    const h = await harness();
    await connectDuringRestart(h);
    await h.host.executeCommand('cgremlin.openManagedWorkspace');
    const opened = h.host
      .callsOf('executeCommand')
      .some((call) => call.args[0] === 'vscode.openFolder');
    expect(opened).toBe(true);
  });

  it('says why, rather than doing nothing at all, when it still cannot read the config', async () => {
    const h = await harness();
    await h.server.stop();
    expect(await h.ui.connect()).toBe(false);
    await h.host.executeCommand('cgremlin.openManagedWorkspace');
    expect(lastWarning(h.host)).toBe(WORKSPACE_UNREADABLE_MESSAGE);
  });
});
