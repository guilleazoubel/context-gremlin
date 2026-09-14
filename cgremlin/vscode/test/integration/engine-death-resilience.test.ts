/**
 * Integration: the engine dies mid-session, and the panel stays usable.
 *
 * The incident this pins: a window running old extension code SIGTERM'd the engine every 1.5 s
 * until R26's respawn budget was spent, and the engine then stayed dead — no socket, no
 * `engine.json`, no process. Nothing retried it, the panel said nothing about it, and every click
 * the user made answered with `cgremlin engine is not running`, including opening a Jira page,
 * which needs no engine at all. The only cure was reloading the window.
 *
 * So this drives the shipping wiring — the real `EngineSurface`, the real `EngineManager` and
 * `NodeEngineProcess`, the real `createUi`, the real engine bundle on a real socket — and stops
 * the engine the way the new code stops one: `POST /shutdown` with `reason: 'user'`, never a
 * signal. What it then asserts is the whole of Phase 11:
 *
 *  - the panel shows the trouble row, and its primary button is `cgremlin.engine.start`;
 *  - the lists it already had are still there, a row click still expands one from that snapshot,
 *    and "Open in Jira" / "Open on GitHub" still resolve;
 *  - and that one button really does bring the engine back, after which the lists repopulate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { CoreClient } from '../../src/core-client';
import { NodeEngineProcess } from '../../src/engine/node-engine-process';
import type { EngineManager, SignalOutcome } from '../../src/engine/manager';
import { EngineSurface } from '../../src/ui/engine';
import { OFFLINE_DETAIL } from '../../src/ui/panel-view';
import { managedWorkspacePath } from '../../src/ui/preview';
import { createUi, VIEW_ID, type Ui } from '../../src/ui/wiring';
import type { PanelRowView, PanelState } from '../../src/model/panel-protocol';
import { FakeHost, type FakeWebview } from '../support/fake-host';
import { startFakeJira, type FakeJira } from '../support/fake-jira';
import {
  coreIsBuilt,
  createManager,
  ENGINE_BUNDLE,
  loadEngineBridge,
  sleep,
  startEngineViaManager,
  waitForGone,
  waitUntil,
  type CoreHarness,
} from '../support/core-harness';

const JIRA_TOKEN = 'engine-death-jira-token-do-not-leak';
const TIMEOUT = 90_000;

const TICKET_ITEM = 'ticket:APP-1';
const PR_ITEM = 'pr:fake/repo#5';

/** A real port that counts what actually reached the machine. A signal here would be the bug. */
class CountingProcess extends NodeEngineProcess {
  sigterms = 0;

  override signal(pid: number, sig: 'SIGTERM'): SignalOutcome {
    this.sigterms += 1;
    return super.signal(pid, sig);
  }
}

describe.skipIf(!coreIsBuilt())('integration: the engine dies and the panel stays usable', () => {
  let h: CoreHarness;
  let jira: FakeJira;
  let host: FakeHost;
  let ui: Ui;
  let surface: EngineSurface;
  let manager: EngineManager;
  let port: CountingProcess;
  let panelView: FakeWebview;

  function state(): PanelState {
    const renders = panelView.renders();
    if (renders.length === 0) throw new Error('the host posted no render');
    return (renders[renders.length - 1] as { state: PanelState }).state;
  }

  function rowOf(id: string): PanelRowView {
    const found = state()
      .sections.flatMap((section) => section.rows)
      .find((row) => row.id === id);
    if (found === undefined) throw new Error(`no row '${id}' in the panel`);
    return found;
  }

  /** Everything the user was told, as one string — the incident's message must not be in it. */
  function warnings(): string {
    return host
      .callsOf('showWarningMessage')
      .map((call) => String(call.args[0]))
      .join('\n');
  }

  beforeAll(async () => {
    jira = await startFakeJira({ apiToken: JIRA_TOKEN });
    h = await startEngineViaManager({ jira: { baseUrl: jira.baseUrl, apiToken: JIRA_TOKEN } });
    expect((await h.client.scan()).status).toBe(200);
    await waitUntil(
      () => h.client.items(),
      (listing) => listing.items.some((item) => item.id === TICKET_ITEM),
      { timeoutMs: 20_000, what: 'the Jira leg to publish a ticket item' },
    );

    // ---- one window, wired the way `extension.ts` wires one --------------
    host = new FakeHost();
    host.files.set(h.configPath, '{}'); // `bootstrap` only asks whether it is there
    host.workspaceFilePath = managedWorkspacePath(h.stateDir);
    host.folders = [path.join(h.worktreesDir, h.seeded.looseInvestigation)];
    port = new CountingProcess({ env: h.env, shell: h.loginShell });
    manager = createManager(h, { process: port });
    surface = new EngineSurface({
      host,
      manager,
      bridge: loadEngineBridge(),
      configPath: () => h.configPath,
      home: h.stateDir,
      execPath: process.execPath,
      enginePath: ENGINE_BUNDLE,
      resolveLoginPath: async () => null,
      reconnect: async () => {
        await ui.connect();
      },
    });
    ui = createUi({
      host,
      client: new CoreClient(h.socketPath),
      notificationLevel: () => 'off',
      engine: surface,
      coalesceMs: 0,
    });
    await surface.bootstrap();
    expect(await ui.connect()).toBe(true);
    panelView = host.resolveView(VIEW_ID).webview;
    panelView.emit({ type: 'ready' });
  }, TIMEOUT);

  afterAll(async () => {
    surface?.dispose();
    await ui?.dispose();
    await h?.cleanup();
    await jira?.stop();
  }, TIMEOUT);

  it('lists the work while the engine is up', () => {
    expect(state().trouble).toBeNull();
    expect(rowOf(TICKET_ITEM).id).toBe(TICKET_ITEM);
    expect(rowOf(PR_ITEM).id).toBe(PR_ITEM);
  });

  it('stops the engine by REQUEST, and shows a trouble row whose first button starts it', async () => {
    host.messageAnswers = ['Stop the engine'];
    await host.invoke('cgremlin.engine.stop');
    await surface.settled();
    await waitForGone(h.socketPath, 'the socket file', 15_000);
    await waitForGone(h.enginePidPath, 'engine.json', 15_000);

    // A request, answered — not a signal that cannot be refused.
    expect(port.sigterms).toBe(0);
    expect(manager.state().kind).toBe('stopped');

    const trouble = state().trouble;
    expect(trouble?.message).toContain('is not running');
    expect(trouble?.command).toBe('cgremlin.engine.start');
    expect(trouble?.actionLabel).toBe('Start the engine');
    expect(trouble?.secondary).toEqual({
      command: 'cgremlin.engine.showLog',
      actionLabel: 'Show log',
    });
  }, TIMEOUT);

  it('keeps the rows it had, and still expands one from the snapshot', async () => {
    const row = rowOf(TICKET_ITEM);
    panelView.emit({ type: 'selectRow', id: TICKET_ITEM, list: row.list });
    await ui.settled();
    await sleep(200);

    const opened = rowOf(TICKET_ITEM);
    expect(opened.expanded).toBe(true);
    expect(opened.parts.length).toBeGreaterThan(0);
    expect(opened.detailNotice).toBe(OFFLINE_DETAIL);
    expect(warnings()).not.toContain('is not running');
  }, TIMEOUT);

  it('opens the ticket and the pull request with no engine at all', async () => {
    await host.invoke('cgremlin.openTicket', TICKET_ITEM);
    await host.invoke('cgremlin.openPr', PR_ITEM);
    const opened = host.callsOf('openExternal').map((call) => String(call.args[0]));
    expect(opened.some((url) => url.includes('/browse/APP-1'))).toBe(true);
    expect(opened.some((url) => url.includes('/pull/5'))).toBe(true);
    expect(warnings()).not.toContain('is not running');
  }, TIMEOUT);

  it('brings the engine back on one click, and the lists come back with it', async () => {
    panelView.emit({
      type: 'command',
      command: state().trouble?.command ?? '',
      id: 'engine',
    });
    await waitUntil(
      async () => manager.state().kind,
      (kind) => kind === 'running',
      { timeoutMs: 30_000, what: 'the engine the trouble row started' },
    );
    await surface.settled();
    await ui.settled();
    await sleep(200);

    expect(port.sigterms).toBe(0);
    expect(state().trouble).toBeNull();
    expect(rowOf(TICKET_ITEM).id).toBe(TICKET_ITEM);
    expect(rowOf(PR_ITEM).id).toBe(PR_ITEM);
  }, TIMEOUT);
});
