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
import { CoreClient } from '../../src/core-client';
import { createUi, type Ui } from '../../src/ui/wiring';
import { validatePrUrl, validateTicket } from '../../src/ui/commands';
import { heartbeatIntervalMs } from '../../src/ui/terminal';
import { FakeHost } from '../support/fake-host';
import { FakeBridge, FakeEngineManager } from '../support/fake-engine-manager';
import { EngineSurface } from '../../src/ui/engine';
import { startStubServer, type StubHandler, type StubServerHandle } from '../support/stub-server';
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

async function harness(opts: { handler?: StubHandler; socketPath?: string } = {}): Promise<Harness> {
  const server = await startStubServer({ handler: opts.handler });
  servers.push(server);
  const host = new FakeHost();
  const level = { value: 'all' as NotificationLevel };
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
    client: new CoreClient(opts.socketPath ?? server.socketPath),
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
    state().lists.flatMap((list) => list.sections.flatMap((section) => section.rows));
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

async function connected(opts: { handler?: StubHandler } = {}): Promise<Harness> {
  const h = await harness(opts);
  expect(await h.ui.connect()).toBe(true);
  return h;
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

  it('shows exactly one warning across five failed connection attempts', async () => {
    const h = await harness();
    await h.server.dispose();
    servers.splice(servers.indexOf(h.server), 1);
    expect(await h.ui.connect()).toBe(false);
    for (let i = 0; i < 4; i += 1) await h.ui.offline();
    await h.ui.settled();
    const warnings = h.host.callsOf('showWarningMessage');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].args[0]).toBe('cgremlin engine is not running');
    expect(warnings[0].args[2]).toEqual(['Start it', 'Settings']);
    expect(h.host.statusBarItems[0].text).toBe('$(circle-slash) cgremlin: offline');
  });

  // MG-C7: the engine is started by the manager, never by typing a command into a terminal.
  it('starts the engine through the manager when Start it is picked', async () => {
    const h = await harness();
    await h.server.dispose();
    servers.splice(servers.indexOf(h.server), 1);
    h.host.messageAnswers = ['Start it'];
    expect(await h.ui.connect()).toBe(false);
    await h.ui.settled();
    expect(h.engine.calls).toEqual(['ensureRunning:user']);
    expect(h.host.terminals).toHaveLength(0);
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

  it('renders the four lists from that one response', async () => {
    const h = await connected();
    expect(h.state().lists.map((l) => `${l.kind}:${l.count}`)).toEqual([
      'parkingLot:5',
      'myWork:2',
      'investigations:1',
      'waitingForReview:2',
    ]);
  });
});

describe('an engine that is not one this extension can use', () => {
  const FOREIGN = { kind: 'foreign' } as const;

  it('replaces the lists with one explanation of what happened', async () => {
    const h = await connected();
    h.engine.emit(FOREIGN);
    expect(h.state().lists).toEqual([]);
    expect(h.state().trouble?.message).toContain('not a cgremlin engine this extension can use');
    expect(h.state().trouble?.message).toContain('cgremlin: Start the engine');
    expect(h.state().trouble?.command).toBe('cgremlin.engine.start');
  });

  it('shows the failure and a way to the log when the engine failed', async () => {
    const h = await connected();
    h.engine.emit({ kind: 'failed', reason: 'the engine exited with code 1', logTail: [] });
    expect(h.state().trouble?.message).toContain('the engine exited with code 1');
    expect(h.state().trouble?.command).toBe('cgremlin.engine.showLog');
  });

  it('warns in the status bar, in the engine warning colour', async () => {
    const h = await connected();
    h.engine.emit(FOREIGN);
    expect(h.host.statusBarItems[0].text).toBe('$(warning) cgremlin: engine not usable');
    expect(h.host.statusBarItems[0].command).toBe('cgremlin.engine.start');
    expect(h.host.statusBarItems[0].warning).toBe(true);
  });

  it('gives the four lists back the moment a usable engine is adopted', async () => {
    const h = await connected();
    h.engine.emit(FOREIGN);
    expect(h.state().lists).toEqual([]);
    h.engine.emit({ kind: 'running', version: '0.0.1', pid: 10, adopted: true });
    expect(h.state().lists).toHaveLength(4);
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
    const warnings = h.host.callsOf('showWarningMessage');
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0].args[0])).toContain('not a cgremlin engine this extension can use');
    expect(warnings[0].args[2]).toEqual(['Re-probe', 'Show log']);
  });

  it('keeps the panel alive when the engine serves no /items yet', async () => {
    const h = await harness({
      handler: (req) =>
        req.path === '/items' ? { status: 404, body: { error: 'not found' } } : undefined,
    });
    expect(await h.ui.connect()).toBe(true);
    expect(h.state().lists).toHaveLength(0);
    expect(h.host.logs.some((line) => line.includes('GET /items failed'))).toBe(true);
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
    expect(String(h.host.callsOf('showInformationMessage')[0].args[0])).toContain('stopped');
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
  it('writes the managed file once and opens it only after the user consents', async () => {
    const h = await connected();
    h.host.workspaceFilePath = undefined;
    h.host.messageAnswers = ['Open the cgremlin workspace'];
    await h.host.invoke('cgremlin.openItem', REVIEW_ITEM);
    expect(h.host.callsOf('writeFile').map((c) => c.args[0])).toEqual([MANAGED]);
    expect(JSON.parse(h.host.files.get(MANAGED) as string).folders).toHaveLength(1);
    expect(h.host.callsOf('updateWorkspaceFolders')).toEqual([]);
    const opens = h.host.callsOf('executeCommand').filter((c) => c.args[0] === 'vscode.openFolder');
    expect(opens).toHaveLength(1);
    expect((opens[0].args[1] as { fsPath: string }).fsPath).toBe(MANAGED);

    // A second open does not rewrite a managed file that is already there.
    h.host.messageAnswers = [undefined];
    await h.host.invoke('cgremlin.openItem', REVIEW_ITEM);
    expect(h.host.callsOf('writeFile')).toHaveLength(1);
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
    const actions = h.rowOf(MY_PR_ITEM).actions.map((a) => a.command);
    expect(actions).toContain('cgremlin.addressReview');
    expect(actions).not.toContain('cgremlin.chat');
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

describe('MG-B2 only-needs-you-pops (host half)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await connected();
  });

  it('pops once per item entering needsYou, offering Open and Ack', async () => {
    h.ui.notifications.apply([], h.ui.coordinator.items(), 'all');
    const popups = h.host.callsOf('showInformationMessage');
    expect(popups).toHaveLength(3);
    expect(popups[0].args[2]).toEqual(['Open', 'Ack']);
    expect(popups.map((p) => String(p.args[0])).join('\n')).toContain('review_ready');
  });

  it('pops nothing at level off, and nothing for an unchanged snapshot', async () => {
    const items = h.ui.coordinator.items();
    h.ui.notifications.apply([], items, 'off');
    h.ui.notifications.apply(items, items, 'all');
    await h.ui.settled();
    expect(h.host.callsOf('showInformationMessage')).toEqual([]);
  });

  it('Open opens the Item tab for that id and Ack posts the one item ack', async () => {
    h.host.messageAnswers = ['Open', 'Ack', undefined, undefined];
    const mark = h.mark();
    h.ui.notifications.apply([], h.ui.coordinator.items(), 'all');
    await h.ui.settled();
    const seen = paths(h, mark);
    expect(seen.some((p) => p.startsWith('GET /items/'))).toBe(true);
    expect(seen.some((p) => p.endsWith('/ack'))).toBe(true);
    expect(seen.every((p) => p !== 'POST /attention/ack')).toBe(true);
  });
});
