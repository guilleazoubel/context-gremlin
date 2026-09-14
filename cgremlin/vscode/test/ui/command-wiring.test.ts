/**
 * The extension-host wiring, exercised against a hand-written `Host` (test/support/fake-host.ts)
 * and a `CoreClient` pointed at B1's stub server. No editor module is loaded anywhere in here,
 * and nothing is module-mocked: `createUi` is the very same composition `extension.ts` calls.
 *
 * Phase 9: the panel is a webview (R54) and every item-addressed call goes through
 * `/items/<path>` (R14/R65), so the rows here are read out of the panel's rendered state rather
 * than out of a tree.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CoreClient, EngineNotRunningError, type HttpResult } from '../../src/core-client';
import type { EngineState, Trigger } from '../../src/engine/manager';
import { createUi, type Ui } from '../../src/ui/wiring';
import { validatePrUrl, validateTicket } from '../../src/ui/commands';
import { heartbeatIntervalMs } from '../../src/ui/terminal';
import { FakeHost, FakeWebviewView } from '../support/fake-host';
import { FakeBridge, FakeEngineManager } from '../support/fake-engine-manager';
import { EngineSurface } from '../../src/ui/engine';
import { fixtures, startStubServer, type StubHandler, type StubServerHandle } from '../support/stub-server';
import itemsFixture from '../support/fixtures/items.json';
import type { NotificationLevel } from '../../src/model/notify-policy';
import type { PanelRowView, PanelState } from '../../src/model/panel-protocol';

const STATE_DIR = '/tmp/cgremlin-fixture';
const MANAGED = `${STATE_DIR}/cgremlin.code-workspace`;
const REVIEW_ID = 'pr-acme-web-102';
const REVIEW_WORKTREE = `${STATE_DIR}/worktrees/${REVIEW_ID}`;
const REVIEW_ITEM = 'pr:acme/web#102';
const MY_PR_ITEM = 'pr:acme/web#200';
const PARKING_ITEM = 'pr:acme/web#101';
const HB_ITEM = 'ticket:HB-627';

const servers: StubServerHandle[] = [];
const uis: Ui[] = [];

afterEach(async () => {
  for (const ui of uis.splice(0)) await ui.dispose();
  for (const server of servers.splice(0)) await server.dispose();
});

interface Harness {
  host: FakeHost;
  engine: FakeEngineManager;
  server: StubServerHandle;
  ui: Ui;
  level: { value: NotificationLevel };
  since(mark: number): { method: string; path: string; body: unknown }[];
  mark(): number;
  /** The panel's last rendered state — the view says `ready` as soon as it is resolved. */
  state(): PanelState;
  rows(): PanelRowView[];
  rowOf(id: string): PanelRowView;
  toPanel(message: unknown): void;
}

interface HarnessOptions {
  handler?: StubHandler;
  socketPath?: string;
  /** A client that can be made to answer "no engine at all", for the revival tests. */
  client?: (socketPath: string) => CoreClient;
  /** A manager that reacts to a `'user'` start, for the revival tests. */
  engine?: () => FakeEngineManager;
}

async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const server = await startStubServer({ handler: opts.handler });
  servers.push(server);
  const host = new FakeHost();
  const level = { value: 'needs-you-only' as NotificationLevel };
  const engine = opts.engine?.() ?? new FakeEngineManager();
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
    client: (opts.client ?? ((p: string) => new CoreClient(p)))(
      opts.socketPath ?? server.socketPath,
    ),
    notificationLevel: () => level.value,
    engine: surface,
    coalesceMs: 5,
    assets: {
      itemTab: { scriptText: '/* tab */', styleText: '/* tab */' },
      panel: { scriptText: '/* panel */', styleText: '/* panel */' },
      mediaPath: '/ext/media',
    },
  });
  uis.push(ui);
  // The editor resolves the view and the script announces itself; from here on every render
  // reaches the fake webview (R54's handshake).
  const view = host.resolveView('cgremlin.items');
  view.webview.emit({ type: 'ready' });
  const state = (): PanelState => {
    const render = [...view.webview.posted]
      .reverse()
      .find((m) => (m as { type?: string }).type === 'render') as { state: PanelState } | undefined;
    if (render === undefined) throw new Error('the panel rendered nothing');
    return render.state;
  };
  const rows = (): PanelRowView[] =>
    state().sections.flatMap((section) => section.rows);
  return {
    host,
    server,
    ui,
    engine,
    level,
    mark: () => server.requests.length,
    since: (m) =>
      server.requests.slice(m).map((r) => ({ method: r.method, path: r.path, body: r.body })),
    state,
    rows,
    rowOf: (id) => {
      const row = rows().find((r) => r.id === id);
      if (row === undefined) throw new Error(`no row ${id} in the panel`);
      return row;
    },
    toPanel: (message) => view.webview.emit(message),
  };
}

async function connected(opts: HarnessOptions = {}): Promise<Harness> {
  const h = await harness(opts);
  expect(await h.ui.connect()).toBe(true);
  return h;
}

/** The expanded row's two reads are real round trips over the socket, not microtasks. */
async function settleDetail(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

function paths(h: Harness, mark: number): string[] {
  return h.since(mark).map((r) => `${r.method} ${r.path}`);
}

// ---------------------------------------------------------------------------

describe('activation and the not-running UX', () => {
  it('registers exactly the commands package.json contributes', async () => {
    const h = await connected();
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'),
    ) as { contributes: { commands: { command: string }[] } };
    const contributed = manifest.contributes.commands.map((c) => c.command).sort();
    expect([...h.host.commands.keys()].sort()).toEqual(contributed);
  });

  it('registers the panel as a webview view provider, with its context retained', async () => {
    const h = await connected();
    const call = h.host.callsOf('registerWebviewViewProvider')[0];
    expect(call.args[0]).toBe('cgremlin.items');
    expect(call.args[1]).toEqual({ webviewOptions: { retainContextWhenHidden: true } });
  });

  it('says "offline" in the status bar, and raises no popup, across five failed attempts', async () => {
    const h = await harness();
    await h.server.dispose();
    servers.splice(servers.indexOf(h.server), 1);
    expect(await h.ui.connect()).toBe(false);
    for (let i = 0; i < 4; i += 1) await h.ui.offline();
    // The verdict waits out its window (P0-1); the status bar is where it lands.
    h.host.flushTimeouts();
    await h.ui.settled();
    expect(h.host.statusBarItems[0].text).toBe('$(circle-slash) cgremlin: offline');
    // P10: the panel's trouble row already explains this and offers the same two actions. A
    // popup on top of it is the same sentence twice, over whatever the user was doing.
    expect(h.host.callsOf('showWarningMessage')).toEqual([]);
    expect(h.host.callsOf('showInformationMessage')).toEqual([]);
  });

  /**
   * P0-1. The SSE stream drops on every engine restart and on every hiccup, and the consumer
   * reconnects on a 1/2/5/10 s backoff — so a banner raised on the first drop flaps for reasons
   * the user cannot act on, and the flapping engine made it flap all day. A drop is only news
   * once it has lasted, and the lists keep the snapshot they had throughout.
   */
  describe('a dropped connection waits out a window before it is news (P0-1)', () => {
    it('says nothing, and blanks nothing, for a drop that has not lasted 8 s', async () => {
      const h = await connected();
      const before = h.rows().length;
      expect(before).toBeGreaterThan(0);

      await h.ui.offline();
      await h.ui.settled();
      expect(h.host.callsOf('showWarningMessage')).toHaveLength(0);
      expect(h.host.statusBarItems[0].text).not.toContain('offline');
      // The panel still shows the work it was showing: a transient drop is not a reason to
      // replace four lists with nothing.
      expect(h.rows()).toHaveLength(before);
      expect(h.ui.coordinator.items().length).toBeGreaterThan(0);
      // And the window it is waiting out is the specified one.
      expect(h.host.pendingTimeouts()).toContain(8_000);
    });

    it('says it once the window passes with the connection still down', async () => {
      const h = await connected();
      await h.server.dispose();
      servers.splice(servers.indexOf(h.server), 1);
      await h.ui.offline();
      h.host.flushTimeouts();
      await h.ui.settled();
      expect(h.host.statusBarItems[0].text).toBe('$(circle-slash) cgremlin: offline');
      expect(h.host.callsOf('showWarningMessage')).toEqual([]);
      // Even then, the last snapshot is what the panel has: blanking it says less than it shows.
      expect(h.ui.coordinator.items().length).toBeGreaterThan(0);
    });

    it('forgets the whole thing the moment a request gets through', async () => {
      const h = await connected();
      await h.ui.offline();
      await h.ui.coordinator.refreshNow();
      h.host.flushTimeouts();
      await h.ui.settled();
      expect(h.host.callsOf('showWarningMessage')).toHaveLength(0);
      expect(h.host.statusBarItems[0].text).not.toContain('offline');
    });

    it('forgets it for a frame that arrives, too', async () => {
      const h = await connected();
      await h.ui.offline();
      h.ui.handleFrame({ event: 'attention.changed', data: { id: 'pr:fake/repo#3' } });
      h.host.flushTimeouts();
      await h.ui.settled();
      expect(h.host.callsOf('showWarningMessage')).toHaveLength(0);
      expect(h.host.statusBarItems[0].text).not.toContain('offline');
    });
  });
});

describe('R24 one refresh, one request', () => {
  it('issues GET /items and nothing else, after the one GET /config at connect', async () => {
    const h = await harness();
    const mark = h.mark();
    expect(await h.ui.connect()).toBe(true);
    expect(paths(h, mark)).toEqual(['GET /config', 'GET /items']);

    const second = h.mark();
    h.ui.coordinator.schedule();
    h.ui.coordinator.schedule();
    h.ui.coordinator.schedule();
    h.host.flushTimeouts();
    await h.ui.coordinator.settled();
    expect(paths(h, second)).toEqual(['GET /items']);
  });

  it('renders the six sections from that one response', async () => {
    const h = await connected();
    // §5: every section counts what it holds, and there is no level above it left to over-claim.
    expect(h.state().sections.map((s) => `${s.key}:${s.count}`)).toEqual([
      'parkingLot:untouched:3',
      'parkingLot:reviewing:1',
      'parkingLot:someoneOnIt:1',
      'myWork:3',
      'investigations:1',
      'waitingForReview:3',
    ]);
  });
});

describe('an engine that is not one this extension can use', () => {
  const FOREIGN = { kind: 'foreign' } as const;

  it('explains what happened, above whatever it had already listed', async () => {
    const h = await connected();
    h.engine.emit(FOREIGN);
    expect(h.state().trouble?.message).toContain('not a cgremlin engine this extension can use');
    expect(h.state().trouble?.message).toContain('cgremlin: Start the engine');
    expect(h.state().trouble?.command).toBe('cgremlin.engine.start');
  });

  it('shows the failure, offers a start first and keeps the log beside it', async () => {
    const h = await connected();
    h.engine.emit({ kind: 'failed', reason: 'the engine exited with code 1', logTail: [] });
    expect(h.state().trouble?.message).toContain('the engine exited with code 1');
    expect(h.state().trouble?.command).toBe('cgremlin.engine.start');
    expect(h.state().trouble?.secondary).toEqual({
      command: 'cgremlin.engine.showLog',
      actionLabel: 'Show log',
    });
  });

  /** With no engine at all, the panel owes the user one click that brings it back. */
  it('offers a start when the engine is simply not running', async () => {
    const h = await connected();
    h.engine.emit({ kind: 'stopped' });
    expect(h.state().trouble?.message).toContain('is not running');
    expect(h.state().trouble?.command).toBe('cgremlin.engine.start');
    expect(h.state().trouble?.actionLabel).toBe('Start the engine');
  });

  it('warns in the status bar, in the engine warning colour', async () => {
    const h = await connected();
    h.engine.emit(FOREIGN);
    expect(h.host.statusBarItems[0].text).toBe('$(warning) cgremlin: engine not usable');
    expect(h.host.statusBarItems[0].command).toBe('cgremlin.engine.start');
    expect(h.host.statusBarItems[0].warning).toBe(true);
  });

  it('clears the explanation the moment a usable engine is adopted', async () => {
    const h = await connected();
    h.engine.emit(FOREIGN);
    expect(h.state().trouble).not.toBeNull();
    h.engine.emit({ kind: 'running', version: '0.0.1', pid: 10, adopted: true });
    expect(h.state().trouble).toBeNull();
    expect(h.state().sections).toHaveLength(6);
    expect(h.host.statusBarItems[0].warning).toBe(false);
  });

  it('treats a 404 from GET /config exactly like a foreign socket', async () => {
    const h = await harness({
      handler: (req) =>
        req.path === '/config' ? { status: 404, body: { error: 'not found' } } : undefined,
    });
    expect(await h.ui.connect()).toBe(false);
    await h.ui.settled();
    expect(h.host.statusBarItems[0].text).toBe('$(warning) cgremlin: engine not usable');
    // P10: the panel's trouble row carries the sentence and the fix; no popup is raised.
    expect(h.host.callsOf('showWarningMessage')).toEqual([]);
    expect(h.host.callsOf('showInformationMessage')).toEqual([]);
    expect(String(h.state().trouble?.message)).toContain(
      'not a cgremlin engine this extension can use',
    );
    // Its one button IS the re-probe: `cgremlin.engine.start` is `ensureRunning('user')`.
    expect(h.state().trouble?.command).toBe('cgremlin.engine.start');
  });

  it('finding 2 — an engine with no /items says so, with a Restart, not an empty panel', async () => {
    const h = await harness({
      handler: (req) =>
        req.path === '/items' ? { status: 404, body: { error: 'not found' } } : undefined,
    });
    expect(await h.ui.connect()).toBe(true);
    expect(h.state().sections).toHaveLength(0);
    expect(h.state().trouble?.message).toBe(
      'The engine is older than this extension (no /items). Restart the engine to load the ' +
        'bundled version.',
    );
    expect(h.state().trouble?.command).toBe('cgremlin.engine.restart');
    expect(h.state().trouble?.actionLabel).toBe('Restart the engine');
    expect(h.host.statusBarItems[0].text).toBe('$(warning) cgremlin: engine is out of date');
    expect(h.host.statusBarItems[0].warning).toBe(true);
    expect(h.host.logs.some((line) => line.includes('GET /items failed'))).toBe(true);
  });

  it('finding 2 — the Restart action is the engine manager’s user restart', async () => {
    const h = await harness({
      handler: (req) =>
        req.path === '/items' ? { status: 404, body: { error: 'not found' } } : undefined,
    });
    expect(await h.ui.connect()).toBe(true);
    h.toPanel({ type: 'command', command: h.state().trouble?.command ?? '', id: 'engine' });
    await h.ui.settled();
    expect(h.engine.calls).toContain('restart:user');
  });

  it('finding 2 — any other /items failure is surfaced with the engine’s own message', async () => {
    const h = await harness({
      handler: (req) =>
        req.path === '/items'
          ? { status: 500, body: { error: 'the work model exploded' } }
          : undefined,
    });
    expect(await h.ui.connect()).toBe(true);
    expect(h.state().sections).toHaveLength(0);
    expect(h.state().trouble?.message).toContain('the work model exploded');
    expect(h.state().trouble?.command).toBe('cgremlin.engine.showLog');
    expect(h.host.statusBarItems[0].warning).toBe(true);
  });

  /**
   * R35's other half: a Jira that rejected the token is not "the engine cannot list the work" —
   * the PR rows are all still good — so it keeps the lists and colours the bar instead.
   */
  it('a Jira 401 warns in the status bar AND keeps the four lists (R35)', async () => {
    const h = await harness({
      handler: (req) =>
        req.path === '/items'
          ? {
              status: 200,
              body: {
                ...(itemsFixture as object),
                ticketSource: { kind: 'auth', error: 'Basic auth is not allowed', scannedAt: null },
              },
            }
          : undefined,
    });
    expect(await h.ui.connect()).toBe(true);
    expect(h.state().sections).toHaveLength(6);
    expect(h.state().trouble).toBeNull();
    expect(h.state().banner).toMatchObject({ kind: 'auth' });
    expect(h.host.statusBarItems[0].text).toBe('$(warning) cgremlin: jira rejected the token');
    expect(h.host.statusBarItems[0].warning).toBe(true);
    expect(h.host.statusBarItems[0].tooltip).toContain('check-jira');
  });

  it('finding 2 — the trouble clears the moment /items answers again', async () => {
    let broken = true;
    const h = await harness({
      handler: (req) =>
        req.path === '/items' && broken ? { status: 404, body: { error: 'not found' } } : undefined,
    });
    expect(await h.ui.connect()).toBe(true);
    expect(h.state().trouble).not.toBeNull();
    broken = false;
    await h.ui.coordinator.refreshNow();
    expect(h.state().trouble).toBeNull();
    expect(h.state().sections).toHaveLength(6);
    expect(h.host.statusBarItems[0].warning).toBe(false);
  });
});

describe('Refresh while the engine is not running', () => {
  it('explains why nothing happened, and re-probes, instead of doing nothing at all', async () => {
    const h = await connected();
    h.engine.emit({ kind: 'foreign' });
    h.engine.calls.length = 0;
    const mark = h.mark();
    await h.host.invoke('cgremlin.refreshInventory');
    await h.ui.settled();

    expect(h.since(mark)).toEqual([]);
    const said = h.host.callsOf('showInformationMessage');
    expect(said).toHaveLength(1);
    expect(String(said[0].args[0])).toContain('not a cgremlin engine this extension can use');
    expect(h.engine.calls).toEqual(['ensureRunning:user']);
  });

  it('names the state when the engine is merely stopped', async () => {
    const h = await connected();
    h.engine.emit({ kind: 'stopped' });
    const mark = h.mark();
    await h.host.invoke('cgremlin.refreshInventory');
    await h.ui.settled();
    expect(h.since(mark)).toEqual([]);
    expect(String(h.host.callsOf('showInformationMessage')[0].args[0])).toContain(
      'is not running',
    );
  });

  it('scans as it always did when the engine is running', async () => {
    const h = await connected();
    const mark = h.mark();
    await h.host.invoke('cgremlin.refreshInventory');
    expect(paths(h, mark)).toEqual(['POST /prs/scan']);
  });
});

describe('R43 the status bar', () => {
  it('says no repo open until an item has been opened, counting ITEMS that need me', async () => {
    const h = await connected();
    expect(h.host.statusBarItems[0].text).toBe('$(folder) cgremlin: no repo open — 3 need you');
  });

  it('names the selected agent and reads its phase off agents[]', async () => {
    const h = await connected();
    h.host.workspaceFilePath = MANAGED;
    h.host.folders = [REVIEW_WORKTREE];
    await h.host.invoke('cgremlin.openItem', REVIEW_ITEM);
    expect(h.host.statusBarItems[0].text).toBe(
      `$(pulse) cgremlin: ${REVIEW_ID} · review_ready — 3 need you`,
    );
    expect(h.host.statusBarItems[0].tooltip).toContain(REVIEW_WORKTREE);
  });

  it('reads a respond agent’s phase the same way (R43)', async () => {
    const h = await connected();
    await h.host.invoke('cgremlin.openItem', MY_PR_ITEM);
    expect(h.host.statusBarItems[0].text).toContain('respond-acme-web-200 · triaging');
  });
});

describe('cgremlin.openItem', () => {
  it('opens the Item tab and swaps the single managed folder', async () => {
    const h = await connected();
    h.host.workspaceFilePath = MANAGED;
    h.host.folders = [`${STATE_DIR}/worktrees/some-other`];
    const mark = h.mark();
    await h.host.invoke('cgremlin.openItem', REVIEW_ITEM);
    expect(paths(h, mark)).toContain('GET /items/pr/acme/web/102');
    expect(h.host.panels).toHaveLength(1);
    const swaps = h.host.callsOf('updateWorkspaceFolders');
    expect(swaps).toHaveLength(1);
    expect(swaps[0].args).toEqual([0, 1, [{ uri: REVIEW_WORKTREE, name: REVIEW_ID }]]);
  });

  it('R65 — a child opens the SAME tab at the child’s own path', async () => {
    const h = await connected();
    h.toPanel({ type: 'toggleRow', id: HB_ITEM, expanded: true });
    const mark = h.mark();
    await h.host.invoke('cgremlin.openChild', HB_ITEM, 'pr:acme/web#310');
    expect(paths(h, mark)).toContain('GET /items/pr/acme/web/310');
    expect(h.host.panels).toHaveLength(1);
  });

  it('opens nothing and warns when the id is not a row', async () => {
    const h = await connected();
    const mark = h.mark();
    await h.host.invoke('cgremlin.openItem', 'pr:nope/nope#1');
    expect(h.since(mark)).toEqual([]);
    expect(h.host.callsOf('showWarningMessage')).toHaveLength(1);
  });

  it('leaves the workspace alone for a parking-lot row with no agent (R22)', async () => {
    const h = await connected();
    h.host.workspaceFilePath = MANAGED;
    h.host.folders = [`${STATE_DIR}/worktrees/some-other`];
    await h.host.invoke('cgremlin.openItem', PARKING_ITEM);
    expect(h.host.callsOf('updateWorkspaceFolders')).toEqual([]);
    expect(h.host.callsOf('openExternal')).toEqual([]);
  });

  it('opens a PR in the browser only through the explicit Open PR action (R22)', async () => {
    const h = await connected();
    await h.host.invoke('cgremlin.openPr', PARKING_ITEM);
    expect(h.host.callsOf('openExternal').map((c) => c.args[0])).toEqual([
      'https://github.com/acme/web/pull/101',
    ]);
  });

  it('R26 — Open PR picks the PR the action named, not always the first', async () => {
    const h = await connected();
    await h.host.invoke('cgremlin.openPr', HB_ITEM, 'pr:acme/api#88');
    expect(h.host.callsOf('openExternal').map((c) => c.args[0])).toEqual([
      'https://github.com/acme/api/pull/88',
    ]);
  });
});

describe('MG-B5 one-worktree-folder-at-a-time (host half)', () => {
  it('shows a modal warning before any updateWorkspaceFolders call', async () => {
    const h = await connected();
    h.host.workspaceFilePath = MANAGED;
    h.host.folders = [`${STATE_DIR}/worktrees/some-other`];
    h.host.dirty = [`${STATE_DIR}/worktrees/some-other/src/a.ts`];
    h.host.messageAnswers = ['Switch anyway'];
    await h.host.invoke('cgremlin.openItem', REVIEW_ITEM);
    const order = h.host
      .kinds()
      .filter((k) => k === 'showWarningMessage' || k === 'updateWorkspaceFolders');
    expect(order).toEqual(['showWarningMessage', 'updateWorkspaceFolders']);
    const modal = h.host.callsOf('showWarningMessage')[0];
    expect(modal.args[1]).toEqual({ modal: true });
    expect(modal.args[2]).toEqual(['Switch anyway']);
  });

  it('leaves the workspace untouched when the modal is dismissed, and still opens the tab', async () => {
    const h = await connected();
    h.host.workspaceFilePath = MANAGED;
    h.host.folders = [`${STATE_DIR}/worktrees/some-other`];
    h.host.dirty = [`${STATE_DIR}/worktrees/some-other/src/a.ts`];
    h.host.messageAnswers = [undefined];
    await h.host.invoke('cgremlin.openItem', REVIEW_ITEM);
    expect(h.host.callsOf('updateWorkspaceFolders')).toEqual([]);
    expect(h.host.panels).toHaveLength(1);
  });

  it('does not confirm when the dirty document is outside the folders being removed', async () => {
    const h = await connected();
    h.host.workspaceFilePath = MANAGED;
    h.host.folders = [`${STATE_DIR}/worktrees/some-other`];
    h.host.dirty = ['/somewhere/else/notes.md'];
    await h.host.invoke('cgremlin.openItem', REVIEW_ITEM);
    expect(h.host.callsOf('showWarningMessage')).toEqual([]);
    expect(h.host.callsOf('updateWorkspaceFolders')).toHaveLength(1);
  });
});

describe('MG-B3 no-extension-host-restart (host half)', () => {
  it('writes the managed file and offers it in the PANEL — a row click raises no popup', async () => {
    const h = await connected();
    h.host.workspaceFilePath = undefined;
    h.toPanel({ type: 'selectRow', id: REVIEW_ITEM, list: 'myWork' });
    await h.ui.settled();
    await new Promise((resolve) => setTimeout(resolve, 5));

    // The complaint, as an assertion: clicking a row while this window is not the managed
    // workspace says nothing out loud at all.
    expect(h.host.callsOf('showInformationMessage')).toEqual([]);
    expect(h.host.callsOf('writeFile').map((c) => c.args[0])).toEqual([MANAGED]);
    expect(JSON.parse(h.host.files.get(MANAGED) as string).folders).toHaveLength(1);
    expect(h.host.callsOf('updateWorkspaceFolders')).toEqual([]);
    expect(
      h.host.callsOf('executeCommand').filter((c) => c.args[0] === 'vscode.openFolder'),
    ).toEqual([]);
    // The offer is in the panel instead, and the expanded row repeats it inline.
    expect(h.state().notice).toMatchObject({ command: 'cgremlin.openManagedWorkspace' });
    expect(h.rowOf(REVIEW_ITEM).hint).toBe(h.state().notice?.message);

    // A second click still says nothing, and does not rewrite a managed file already there.
    h.toPanel({ type: 'selectRow', id: REVIEW_ITEM, list: 'myWork' });
    await h.ui.settled();
    expect(h.host.callsOf('showInformationMessage')).toEqual([]);
    expect(h.host.callsOf('writeFile')).toHaveLength(1);
  });

  it('opens the managed workspace when the command asks, ignoring an earlier "Not now"', async () => {
    const h = await connected();
    h.host.workspaceFilePath = undefined;
    h.toPanel({ type: 'selectRow', id: REVIEW_ITEM, list: 'myWork' });
    await h.ui.settled();
    h.toPanel({ type: 'dismissNotice' });
    expect(h.state().notice).toBeNull();

    await h.host.invoke('cgremlin.openManagedWorkspace');
    const opens = h.host.callsOf('executeCommand').filter((c) => c.args[0] === 'vscode.openFolder');
    expect(opens).toHaveLength(1);
    expect((opens[0].args[1] as { fsPath: string }).fsPath).toBe(MANAGED);
  });

  it('swaps the worktree without a word once the managed workspace IS the window', async () => {
    const h = await connected();
    h.host.workspaceFilePath = MANAGED;
    h.host.folders = [`${STATE_DIR}/worktrees/some-other`];
    h.host.dirty = [];
    await h.host.invoke('cgremlin.openItem', REVIEW_ITEM);
    expect(h.host.callsOf('updateWorkspaceFolders')).toHaveLength(1);
    expect(h.host.callsOf('showInformationMessage')).toEqual([]);
  });
});

describe('MG-B4 chat-always-runs-in-the-worktree', () => {
  it('reads the conversation, claims it, then opens the terminal in the worktree', async () => {
    const h = await connected();
    const mark = h.mark();
    await h.host.invoke('cgremlin.chat', REVIEW_ITEM);
    expect(paths(h, mark)).toEqual([
      `GET /sessions/${REVIEW_ID}/conversation`,
      `POST /sessions/${REVIEW_ID}/conversation/claim`,
    ]);
    const created = h.host.callsOf('createTerminal');
    expect(created).toHaveLength(1);
    expect(created[0].args[0]).toEqual({ name: `cgremlin: ${REVIEW_ID}`, cwd: REVIEW_WORKTREE });
    expect(h.host.terminals[0].sent).toEqual([
      "claude --resume '7c3f9a10-2b4d-4e51-9f00-8a1b2c3d4e5f'",
    ]);
  });

  it('R48 — an agent child’s Resume chats to THAT agent, not the row’s first', async () => {
    const h = await connected();
    const mark = h.mark();
    await h.host.invoke('cgremlin.chat', HB_ITEM, 'agent:dev-hb-627');
    expect(paths(h, mark)).toEqual([
      'GET /sessions/dev-hb-627/conversation',
      'POST /sessions/dev-hb-627/conversation/claim',
    ]);
  });

  it('finding 1 — the row Chat opens the eligible agent, never a triaging respond one', async () => {
    const h = await connected();
    // The window is "on" the triaging respond agent, which is exactly the state in which
    // falling back to the current session would open a session the Item tab itself gates off.
    h.ui.coordinator.setCurrentSession('respond-acme-api-77', null);
    const row = h.rowOf('pr:acme/api#77');
    const chat = row.actions.find((a) => a.command === 'cgremlin.chat');
    expect(chat).toBeDefined();
    const mark = h.mark();
    await h.host.invoke('cgremlin.chat', 'pr:acme/api#77', chat?.childId);
    expect(paths(h, mark)).toEqual([
      'GET /sessions/dev-acme-api-77/conversation',
      'POST /sessions/dev-acme-api-77/conversation/claim',
    ]);
  });

  it('finding 1 — chatting to a row whose only agent is triaging opens nothing', async () => {
    const h = await connected();
    h.ui.coordinator.setCurrentSession('respond-acme-web-200', null);
    const mark = h.mark();
    await h.host.invoke('cgremlin.chat', MY_PR_ITEM);
    expect(h.since(mark)).toEqual([]);
    expect(h.host.callsOf('createTerminal')).toEqual([]);
    expect(h.host.callsOf('showWarningMessage')).toHaveLength(1);
  });

  it('shows a refused claim verbatim and creates no terminal', async () => {
    const h = await connected({
      handler: (req) =>
        req.path.endsWith('/conversation/claim')
          ? { status: 409, body: { error: "Session 'x' has a run in flight; stop it first" } }
          : undefined,
    });
    await h.host.invoke('cgremlin.chat', REVIEW_ITEM);
    expect(h.host.callsOf('createTerminal')).toEqual([]);
    expect(h.host.callsOf('showWarningMessage')[0].args[0]).toBe(
      "Session 'x' has a run in flight; stop it first",
    );
  });

  it('releases the claim when the terminal closes', async () => {
    const h = await connected();
    await h.host.invoke('cgremlin.chat', REVIEW_ITEM);
    const mark = h.mark();
    h.host.closeTerminal(h.host.terminals[0]);
    await h.ui.chat.settled();
    expect(h.since(mark).map((r) => r.path)).toEqual([
      `/sessions/${REVIEW_ID}/conversation/release`,
    ]);
  });

  it('R20 heartbeats at a third of the TTL from GET /config', async () => {
    const h = await connected();
    expect(heartbeatIntervalMs(600_000)).toBe(200_000);
    await h.host.invoke('cgremlin.chat', REVIEW_ITEM);
    expect(h.host.callsOf('setInterval')[0].args[0]).toBe(200_000);
    const mark = h.mark();
    h.host.advance(600_000);
    await h.ui.chat.settled();
    expect(h.since(mark).map((r) => r.path)).toEqual([
      `/sessions/${REVIEW_ID}/conversation/claim`,
      `/sessions/${REVIEW_ID}/conversation/claim`,
      `/sessions/${REVIEW_ID}/conversation/claim`,
    ]);
  });

  it('R20 dispose releases every outstanding claim and clears its interval', async () => {
    const h = await connected();
    await h.host.invoke('cgremlin.chat', REVIEW_ITEM);
    const mark = h.mark();
    await h.ui.dispose();
    uis.splice(uis.indexOf(h.ui), 1);
    expect(h.since(mark).map((r) => r.path)).toEqual([
      `/sessions/${REVIEW_ID}/conversation/release`,
    ]);
    h.host.advance(600_000);
    await h.ui.chat.settled();
    expect(h.since(mark)).toHaveLength(1);
  });
});

describe('the row commands', () => {
  it('starts a review through POST /items/<path>/agents', async () => {
    const h = await connected();
    const mark = h.mark();
    await h.host.invoke('cgremlin.startReview', PARKING_ITEM);
    expect(h.since(mark)[0]).toEqual({
      method: 'POST',
      path: '/items/pr/acme/web/101/agents',
      body: { mode: 'review' },
    });
  });

  it('refuses to start a review on an item with no pull request', async () => {
    const h = await connected();
    const mark = h.mark();
    await h.host.invoke('cgremlin.startReview', 'session:inv-stacktrace-1');
    expect(h.since(mark)).toEqual([]);
    expect(h.host.callsOf('showWarningMessage')).toHaveLength(1);
  });

  it('shows a 409 from the engine verbatim', async () => {
    const h = await connected({
      handler: (req) =>
        req.path.endsWith('/agents')
          ? { status: 409, body: { error: 'PR acme/web#101 is authored by you' } }
          : undefined,
    });
    await h.host.invoke('cgremlin.startReview', PARKING_ITEM);
    expect(h.host.callsOf('showWarningMessage')[0].args[0]).toBe(
      'PR acme/web#101 is authored by you',
    );
  });

  it('R31 — Ack is ONE request, POST /items/<path>/ack', async () => {
    const h = await connected();
    const mark = h.mark();
    await h.host.invoke('cgremlin.ack', HB_ITEM);
    expect(paths(h, mark)).toEqual(['POST /items/ticket/HB-627/ack']);
    // The extension never loops over the item's refs itself.
    expect(h.since(mark).every((r) => r.path !== '/attention/ack')).toBe(true);
  });

  it('approvePlan, stop and retry each call exactly one session endpoint', async () => {
    const h = await connected();
    for (const [command, expected] of [
      ['cgremlin.approvePlan', 'POST /sessions/inv-hb-627/approve-plan'],
      ['cgremlin.stop', 'POST /sessions/inv-hb-627/stop'],
      ['cgremlin.retry', 'POST /sessions/inv-hb-627/retry'],
    ] as const) {
      const mark = h.mark();
      await h.host.invoke(command, HB_ITEM);
      expect(paths(h, mark)).toEqual([expected]);
    }
  });

  it('surfaces a non-2xx body error verbatim for a row command', async () => {
    const h = await connected({
      handler: (req) =>
        req.method === 'POST' ? { status: 409, body: { error: 'nope, not now' } } : undefined,
    });
    await h.host.invoke('cgremlin.stop', HB_ITEM);
    expect(h.host.callsOf('showWarningMessage')[0].args[0]).toBe('nope, not now');
  });

  it('R15 — a row with no PR asks which repo before starting a session', async () => {
    const h = await connected();
    h.host.quickPickAnswers = ['acme/web'];
    const mark = h.mark();
    await h.host.invoke('cgremlin.startInvestigation', 'session:inv-stacktrace-1');
    expect(h.since(mark)[0]).toEqual({
      method: 'POST',
      path: '/items/session/inv-stacktrace-1/agents',
      body: { mode: 'investigation', repoUrl: 'https://github.com/acme/web.git' },
    });
  });

  /**
   * The defect behind "I click Start investigation and nothing happens": the pick is opened from
   * a webview click, and the panel takes its own focus back on the very next render (the script's
   * `restoreFocus`). A quick pick without `ignoreFocusOut` is dismissed by that, resolves
   * `undefined`, and the command returns in silence.
   */
  it('opens the repo pick so a panel refresh cannot dismiss it', async () => {
    const h = await connected();
    h.host.quickPickAnswers = ['acme/web'];
    await h.host.invoke('cgremlin.startInvestigation', 'session:inv-stacktrace-1');
    const pick = h.host.callsOf('showQuickPick')[0];
    expect(pick.args[0]).toEqual(['acme/web', 'acme/api']);
    expect(pick.args[1]).toMatchObject({ ignoreFocusOut: true });
  });

  it('never asks when core configures exactly one repo', async () => {
    const h = await connected({
      handler: (req) =>
        req.method === 'GET' && req.path === '/config'
          ? { status: 200, body: { config: { ...(fixtures.config as { config: Record<string, unknown> }).config, repos: ['acme/only'] } } }
          : undefined,
    });
    const mark = h.mark();
    await h.host.invoke('cgremlin.startInvestigation', 'session:inv-stacktrace-1');
    expect(h.host.callsOf('showQuickPick')).toEqual([]);
    expect(h.since(mark).filter((r) => r.path.endsWith('/agents'))).toEqual([
      {
        method: 'POST',
        path: '/items/session/inv-stacktrace-1/agents',
        body: { mode: 'investigation', repoUrl: 'https://github.com/acme/only.git' },
      },
    ]);
  });

  it('remembers the repo per item, so the second start does not ask again', async () => {
    const h = await connected();
    h.host.quickPickAnswers = ['acme/api'];
    await h.host.invoke('cgremlin.startInvestigation', 'session:inv-stacktrace-1');
    const mark = h.mark();
    await h.host.invoke('cgremlin.startDevelopment', 'session:inv-stacktrace-1');
    expect(h.host.callsOf('showQuickPick')).toHaveLength(1);
    expect(h.since(mark).filter((r) => r.path.endsWith('/agents'))).toEqual([
      {
        method: 'POST',
        path: '/items/session/inv-stacktrace-1/agents',
        body: { mode: 'development', repoUrl: 'https://github.com/acme/api.git' },
      },
    ]);
  });

  it('surfaces the engine refusal verbatim, and remembers nothing from a failed start', async () => {
    const h = await connected({
      handler: (req) =>
        req.method === 'POST' && req.path.endsWith('/agents')
          ? { status: 400, body: { error: 'repoUrl is required for a ticket-only item' } }
          : undefined,
    });
    h.host.quickPickAnswers = ['acme/web', 'acme/api'];
    await h.host.invoke('cgremlin.startInvestigation', 'session:inv-stacktrace-1');
    expect(h.host.callsOf('showWarningMessage')[0].args[0]).toBe(
      'repoUrl is required for a ticket-only item',
    );
    // A repo that produced a refusal is not the answer to remember: the next click asks again.
    await h.host.invoke('cgremlin.startInvestigation', 'session:inv-stacktrace-1');
    expect(h.host.callsOf('showQuickPick')).toHaveLength(2);
  });

  it('says so when the engine is gone, instead of failing in silence', async () => {
    const h = await connected();
    h.host.quickPickAnswers = ['acme/web'];
    await h.server.dispose();
    servers.splice(servers.indexOf(h.server), 1);
    await h.host.invoke('cgremlin.startInvestigation', 'session:inv-stacktrace-1');
    const warning = h.host.callsOf('showWarningMessage').at(-1);
    // Whatever the socket failure is called, the user is told the start did not happen.
    expect(String(warning?.args[0])).toContain('Could not start the investigation');
  });

  it('selects and opens the row it started work on', async () => {
    const h = await connected();
    h.host.quickPickAnswers = ['acme/web'];
    h.toPanel({ type: 'selectRow', id: MY_PR_ITEM, list: 'myWork' });
    await h.host.invoke('cgremlin.startInvestigation', 'session:inv-stacktrace-1');
    await settleDetail();
    const row = h.rowOf('session:inv-stacktrace-1');
    expect(row.selected).toBe(true);
    expect(row.expanded).toBe(true);
  });
});

describe('R50/R56/R42 the respond click records one run start and zero claim attempts', () => {
  it('posts one agents request, claims nothing and opens no terminal', async () => {
    const h = await connected();
    h.host.workspaceFilePath = MANAGED;
    h.host.folders = [`${STATE_DIR}/worktrees/some-other`];
    const mark = h.mark();
    await h.host.invoke('cgremlin.addressReview', MY_PR_ITEM);
    const requests = h.since(mark);
    expect(requests.filter((r) => r.path.endsWith('/agents'))).toEqual([
      { method: 'POST', path: '/items/pr/acme/web/200/agents', body: { mode: 'respond' } },
    ]);
    expect(requests.filter((r) => /claim|release/.test(r.path))).toEqual([]);
    expect(h.host.callsOf('createTerminal')).toEqual([]);
    // The workspace follows the PR's worktree, once (R22).
    expect(h.host.callsOf('updateWorkspaceFolders')).toHaveLength(1);
    expect(h.host.folders).toEqual([`${STATE_DIR}/worktrees/respond-acme-web-200`]);
  });

  it('refuses on a PR that is not mine', async () => {
    const h = await connected();
    const mark = h.mark();
    await h.host.invoke('cgremlin.addressReview', PARKING_ITEM);
    expect(h.since(mark)).toEqual([]);
    expect(h.host.callsOf('showWarningMessage')).toHaveLength(1);
  });

  it('offers Address review comments, and Chat only from addressing onwards (R50)', async () => {
    const h = await connected();
    // P0-2: the verb belongs to the waiting-for-review row. The same item's `myWork` row is a
    // different question ("what is the state of the thing I'm building?") and a different rule.
    const row = h.state().sections
      .filter((section) => section.list === 'waitingForReview')
      .flatMap((section) => section.rows)
      .find((candidate) => candidate.id === MY_PR_ITEM);
    const actions = (row?.actions ?? []).map((a) => a.command);
    // #200 already has a respond agent, still triaging: no second respond run, and no Chat
    // until it is past `triaging` (R50).
    expect(actions).not.toContain('cgremlin.addressReview');
    expect(actions).not.toContain('cgremlin.chat');

    const hb = h.state().sections
      .filter((section) => section.list === 'waitingForReview')
      .flatMap((section) => section.rows)
      .find((candidate) => candidate.id === HB_ITEM);
    expect((hb?.actions ?? []).map((a) => a.command)).toContain('cgremlin.addressReview');
  });
});

describe('R41 the SSE consumer reads the payload as an address', () => {
  it('refetches the open item only when the frame names it, and always refreshes the panel', async () => {
    const h = await connected();
    await h.host.invoke('cgremlin.openItem', REVIEW_ITEM);
    await h.ui.itemTab.settled();
    const mark = h.mark();

    h.ui.handleFrame({ event: 'item.changed', data: { id: HB_ITEM, kind: 'pr+ticket' } });
    await h.ui.itemTab.settled();
    expect(paths(h, mark)).toEqual([]);

    h.ui.handleFrame({ event: 'item.changed', data: { id: REVIEW_ITEM, kind: 'pr' } });
    await h.ui.itemTab.settled();
    expect(paths(h, mark)).toEqual(['GET /items/pr/acme/web/102']);

    h.host.flushTimeouts();
    await h.ui.settled();
    expect(paths(h, mark)).toContain('GET /items');
  });

  it('re-reads the panel’s open row only when a frame concerns it', async () => {
    const h = await connected();
    const view = new FakeWebviewView();
    h.ui.panel.resolveWebviewView(view);
    view.webview.emit({ type: 'ready' });
    view.webview.emit({ type: 'toggleRow', id: HB_ITEM, expanded: true });
    await h.ui.settled();
    await settleDetail();

    // A burst about other work. Every frame schedules a refresh; none of them may re-read this
    // row's artifacts or its change counts.
    const quiet = h.mark();
    for (let at = 0; at < 20; at += 1) {
      h.ui.handleFrame({ event: 'attention.changed', data: { id: 'pr:acme/web#101' } });
      h.host.flushTimeouts();
      await h.ui.settled();
    }
    await settleDetail();
    expect(paths(h, quiet).filter((request) => request.includes('/changes'))).toEqual([]);
    expect(paths(h, quiet).filter((request) => request.includes(`/items/ticket/HB-627`))).toEqual(
      [],
    );

    // An artifact of one of this row's own sessions: exactly one re-read.
    const named = h.mark();
    const sessionId = (itemsFixture.items.find((i) => i.id === HB_ITEM)?.agents ?? [])[0].sessionId;
    h.ui.handleFrame({ event: 'artifact.changed', data: { sessionId, name: 'PLAN.md' } });
    h.host.flushTimeouts();
    await h.ui.settled();
    await settleDetail();
    expect(paths(h, named).filter((request) => request.includes('/changes'))).toHaveLength(1);
  });

  it('patches one artifact when the frame names one of this item’s agents', async () => {
    const h = await connected();
    await h.host.invoke('cgremlin.openItem', REVIEW_ITEM);
    await h.ui.itemTab.settled();
    const mark = h.mark();
    h.ui.handleFrame({
      event: 'artifact.changed',
      data: { sessionId: REVIEW_ID, name: 'BRIEF.md' },
    });
    await h.ui.itemTab.settled();
    expect(paths(h, mark)).toContain(`GET /sessions/${REVIEW_ID}/artifacts/BRIEF.md`);
  });
});

describe('cgremlin.newInvestigation', () => {
  it('asks the four questions in order, creates, runs findings once and opens the item', async () => {
    const h = await connected();
    h.host.quickPickAnswers = ['acme/api', 'Development-bound', 'Drive to completion'];
    h.host.inputBoxAnswers = ['ING-412'];
    const mark = h.mark();
    await h.host.invoke('cgremlin.newInvestigation');
    expect(
      h.host.calls
        .filter((c) => c.kind === 'showQuickPick' || c.kind === 'showInputBox')
        .map((c) => (c.kind === 'showQuickPick' ? (c.args[0] as string[])[0] : 'input')),
    ).toEqual(['acme/web', 'input', 'Investigate only', 'Stop at the plan']);
    expect(paths(h, mark)).toEqual([
      'POST /sessions/investigations',
      'POST /sessions/created/run',
      'GET /items/session/created',
    ]);
    expect(h.since(mark)[0].body).toEqual({
      repoUrl: 'https://github.com/acme/api.git',
      ticket: 'ING-412',
      intent: 'development',
      driveToCompletion: true,
    });
  });

  it('aborts with no HTTP call when any step is dismissed', async () => {
    const h = await connected();
    for (const c of [
      { quickPick: [undefined], inputBox: [] },
      { quickPick: ['acme/web'], inputBox: [undefined] },
      { quickPick: ['acme/web', undefined], inputBox: ['ING-1'] },
      { quickPick: ['acme/web', 'Investigate only', undefined], inputBox: ['ING-1'] },
    ]) {
      h.host.quickPickAnswers = c.quickPick;
      h.host.inputBoxAnswers = c.inputBox;
      const mark = h.mark();
      await h.host.invoke('cgremlin.newInvestigation');
      expect(h.since(mark)).toEqual([]);
    }
  });

  it('validates the ticket with the same regex the API enforces', () => {
    expect(validateTicket('')).toBeNull();
    expect(validateTicket('ABC-123')).toBeNull();
    expect(validateTicket('a/b')).toBeTypeOf('string');
  });
});

describe('cgremlin.newDevelopmentSession', () => {
  it('asks two questions, creates, runs develop once and opens the item', async () => {
    const h = await connected();
    h.host.quickPickAnswers = ['acme/web'];
    h.host.inputBoxAnswers = ['APP-9'];
    const mark = h.mark();
    await h.host.invoke('cgremlin.newDevelopmentSession');
    expect(paths(h, mark)).toEqual([
      'POST /sessions/developments',
      'POST /sessions/created/run',
      'GET /items/session/created',
    ]);
    expect(h.since(mark)[1].body).toEqual({ stage: 'develop' });
  });
});

describe('R23 cgremlin.newReviewFromUrl', () => {
  const accepted = [
    'https://github.com/o/r/pull/12',
    'https://github.com/o/r/pull/12/files',
    'https://github.com/o/r/pull/12/commits/abc',
  ];
  const rejected = [
    'not a url',
    'https://gitlab.com/o/r/pull/1',
    'https://github.com/o/r',
    'https://github.com/o/r/pull/',
    'https://github.com/o/r/pull/abc',
    'https://github.com/o/pull/12',
    '',
  ];

  it('accepts exactly what the core parser accepts', () => {
    for (const url of accepted) expect(validatePrUrl(url)).toBeNull();
    for (const url of rejected) expect(validatePrUrl(url)).toBeTypeOf('string');
  });

  it('aborts with no HTTP call on Esc', async () => {
    const h = await connected();
    h.host.inputBoxAnswers = [undefined];
    const mark = h.mark();
    await h.host.invoke('cgremlin.newReviewFromUrl');
    expect(h.since(mark)).toEqual([]);
    expect(h.host.lastValidateInput?.('nope')).toBeTypeOf('string');
  });

  it('a 202 opens the new session in the Item tab', async () => {
    const h = await connected();
    h.host.inputBoxAnswers = ['https://github.com/o/r/pull/12'];
    const mark = h.mark();
    await h.host.invoke('cgremlin.newReviewFromUrl');
    expect(paths(h, mark)).toEqual(['POST /reviews', 'GET /items/session/created']);
    expect(h.since(mark)[0].body).toEqual({ prUrl: 'https://github.com/o/r/pull/12' });
  });

  it('a 409 and a 400 show the engine message verbatim and open nothing', async () => {
    for (const status of [409, 400]) {
      const h = await connected({
        handler: (req) =>
          req.path === '/reviews' ? { status, body: { error: `engine says ${status}` } } : undefined,
      });
      h.host.inputBoxAnswers = ['https://github.com/o/r/pull/12'];
      const mark = h.mark();
      await h.host.invoke('cgremlin.newReviewFromUrl');
      expect(h.since(mark).map((r) => r.path)).toEqual(['/reviews']);
      const warning = h.host.callsOf('showWarningMessage')[0];
      expect(warning.args[0]).toContain(`engine says ${status}`);
      expect(warning.args[0]).toContain('https://github.com/o/r/pull/12');
    }
  });
});

describe('MG-B2 needs-you never pops (host half)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await connected();
  });

  it('raises no popup for a whole snapshot entering needs-you, at either level', async () => {
    h.ui.notifications.apply([], h.ui.coordinator.items(), 'needs-you-only');
    h.ui.notifications.apply([], h.ui.coordinator.items(), 'off');
    await h.ui.settled();
    expect(h.host.callsOf('showInformationMessage')).toEqual([]);
    expect(h.host.callsOf('showWarningMessage')).toEqual([]);
  });
});

/**
 * The live incident: an old window SIGTERM'd the engine until the respawn backoff was spent, and
 * the engine stayed dead. Nothing in the extension retried, so every click answered with
 * "cgremlin engine is not running" and the only cure was reloading the window.
 *
 * A person clicking is a person asking for the engine, so a user command that finds the socket
 * empty asks for a start — `'user'`, which bypasses the backoff — and sends its request again.
 */
describe('a user command revives a dead engine', () => {
  /** A client whose socket has gone away, exactly as `CoreClient` reports that. */
  class DeadSocketClient extends CoreClient {
    offline = false;

    override request(method: string, path: string, body?: unknown): Promise<HttpResult> {
      if (this.offline) {
        return Promise.reject(new EngineNotRunningError('/tmp/cgremlin-fixture/engine.sock'));
      }
      return super.request(method, path, body);
    }
  }

  /** The manager as the incident left it: dead, and only a `'user'` ask starts it again. */
  class RevivableEngine extends FakeEngineManager {
    onUserStart: (() => void) | null = null;

    override async ensureRunning(trigger: Trigger = 'auto'): Promise<EngineState> {
      const state = await super.ensureRunning(trigger);
      if (trigger === 'user') this.onUserStart?.();
      return state;
    }
  }

  async function dead(): Promise<{ h: Harness; client: DeadSocketClient }> {
    let client!: DeadSocketClient;
    const h = await connected({
      client: (socketPath) => (client = new DeadSocketClient(socketPath)),
      engine: () => new RevivableEngine(),
    });
    (h.engine as RevivableEngine).onUserStart = () => {
      client.offline = false;
    };
    client.offline = true;
    return { h, client };
  }

  it('asks for a user start and retries the request once, saying nothing at all', async () => {
    const { h } = await dead();
    const mark = h.mark();

    await h.host.invoke('cgremlin.ack', HB_ITEM);

    expect(h.engine.calls).toContain('ensureRunning:user');
    expect(paths(h, mark)).toEqual(['POST /items/ticket/HB-627/ack']);
    expect(h.host.callsOf('showWarningMessage')).toEqual([]);
  });

  it('opens the item tab after the revival rather than reporting the dead socket', async () => {
    const { h } = await dead();

    await h.host.invoke('cgremlin.openItem', HB_ITEM);

    expect(h.engine.calls).toContain('ensureRunning:user');
    expect(h.host.callsOf('showWarningMessage')).toEqual([]);
    expect(h.ui.itemTab.itemId()).toBe(HB_ITEM);
  });

  it('surfaces the engine\'s own wording only when the second attempt fails too', async () => {
    const { h } = await dead();
    (h.engine as RevivableEngine).onUserStart = null;

    await h.host.invoke('cgremlin.ack', HB_ITEM);

    expect(h.engine.calls).toContain('ensureRunning:user');
    expect(String(h.host.callsOf('showWarningMessage')[0]?.args[0])).toContain(
      'cgremlin engine is not running',
    );
  });
});

/**
 * The other half of the incident: with the engine dead, clicking a row answered with the socket
 * error rather than with the row. Everything the submenu needs — the item's parts, its PR and
 * ticket links — is already in the snapshot the panel is holding, and opening a Jira page needs
 * no engine at all. So the lists stay, the row still expands, and the only new thing on screen is
 * one line saying the detail is the last one that loaded.
 */
describe('the panel degrades to its snapshot when the engine goes', () => {
  const OFFLINE_LINE = 'Engine offline — showing what was last loaded';

  async function stopped(): Promise<Harness> {
    let client!: CoreClient;
    const h = await connected({
      client: (socketPath) => {
        client = new (class extends CoreClient {
          override request(method: string, path: string, body?: unknown): Promise<HttpResult> {
            return this.dead
              ? Promise.reject(new EngineNotRunningError(socketPath))
              : super.request(method, path, body);
          }
          dead = false;
        })(socketPath);
        return client;
      },
    });
    (client as CoreClient & { dead: boolean }).dead = true;
    h.engine.emit({ kind: 'stopped' });
    return h;
  }

  it('keeps the lists it already has under the trouble row', async () => {
    const h = await stopped();
    expect(h.state().trouble?.command).toBe('cgremlin.engine.start');
    expect(h.rows().length).toBeGreaterThan(0);
  });

  it('still expands a row, from the snapshot, and says so in one line', async () => {
    const h = await stopped();
    h.toPanel({ type: 'selectRow', id: HB_ITEM, list: 'myWork' });
    await settleDetail();

    const row = h.rowOf(HB_ITEM);
    expect(row.expanded).toBe(true);
    expect(row.parts.length).toBeGreaterThan(0);
    expect(row.detailNotice).toBe(OFFLINE_LINE);
    // A line in the row the user opened, and not a popup over whatever they were doing.
    expect(h.host.callsOf('showWarningMessage')).toEqual([]);
  });

  it('opens the ticket and the pull request with no engine at all', async () => {
    const h = await stopped();
    h.toPanel({ type: 'selectRow', id: HB_ITEM, list: 'myWork' });
    await settleDetail();

    await h.host.invoke('cgremlin.openTicket', HB_ITEM);
    await h.host.invoke('cgremlin.openPr', HB_ITEM);
    expect(h.host.callsOf('openExternal').map((c) => c.args[0])).toEqual([
      'https://aplaceformom.atlassian.net/browse/HB-627',
      'https://github.com/acme/web/pull/310',
    ]);
    expect(h.host.callsOf('showWarningMessage')).toEqual([]);
  });
});
