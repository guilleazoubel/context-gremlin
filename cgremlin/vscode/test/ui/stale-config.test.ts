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
import { FakeHost } from '../support/fake-host';
import { FakeBridge, FakeEngineManager } from '../support/fake-engine-manager';
import { EngineSurface } from '../../src/ui/engine';
import {
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
