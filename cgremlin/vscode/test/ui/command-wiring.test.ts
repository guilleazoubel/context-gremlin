/**
 * The extension-host wiring, exercised against a hand-written `Host` (test/support/fake-host.ts)
 * and a `CoreClient` pointed at B1's stub server. No `vscode` module is loaded anywhere in here,
 * and nothing is module-mocked: `createUi` is the very same composition `extension.ts` calls.
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
import { fixtures, startStubServer, type StubHandler, type StubServerHandle } from '../support/stub-server';
import type { AttentionItem } from '../../src/model/items';
import type { NotificationLevel } from '../../src/model/notify-policy';
import type { TreeNode } from '../../src/ui/tree';

const STATE_DIR = '/tmp/cgremlin-fixture';
const SESSIONS_DIR = `${STATE_DIR}/sessions`;
const MANAGED = `${STATE_DIR}/cgremlin.code-workspace`;
const REVIEW_ID = 'pr-acme-web-102';
const REVIEW_WORKTREE = `${STATE_DIR}/worktrees/${REVIEW_ID}`;

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
  /** Requests the server saw after the given mark. */
  since(mark: number): { method: string; path: string; body: unknown }[];
  mark(): number;
}

async function harness(opts: { handler?: StubHandler; socketPath?: string } = {}): Promise<Harness> {
  let socketPath = opts.socketPath;
  let server: StubServerHandle;
  if (socketPath === undefined) {
    server = await startStubServer({ handler: opts.handler });
    servers.push(server);
    socketPath = server.socketPath;
  } else {
    server = await startStubServer({ handler: opts.handler });
    servers.push(server);
  }
  const host = new FakeHost();
  const level = { value: 'all' as NotificationLevel };
  const engine = new FakeEngineManager();
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
  });
  uis.push(ui);
  return {
    host,
    server,
    ui,
    engine,
    level,
    mark: () => server.requests.length,
    since: (m) => server.requests.slice(m).map((r) => ({ method: r.method, path: r.path, body: r.body })),
  };
}

async function connected(opts: { handler?: StubHandler } = {}): Promise<Harness> {
  const h = await harness(opts);
  expect(await h.ui.connect()).toBe(true);
  return h;
}

function roots(ui: Ui): TreeNode[] {
  return ui.tree.getChildren();
}

function rows(ui: Ui, list: string): TreeNode[] {
  const root = roots(ui).find((n) => n.kind === 'root' && n.list === list);
  if (root === undefined) throw new Error(`no root for ${list}`);
  return ui.tree.getChildren(root);
}

function rowOf(ui: Ui, list: string, ref: string): TreeNode {
  const node = rows(ui, list).find((n) => n.kind === 'row' && n.row.item.ref === ref);
  if (node === undefined) throw new Error(`no row ${ref} in ${list}`);
  return node;
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

describe('the tree provider', () => {
  it('has four roots in LIST_ORDER order carrying the fixture counts', async () => {
    const h = await connected();
    expect(
      roots(h.ui).map((n) => (n.kind === 'root' ? `${n.list}:${n.count}` : 'row')),
    ).toEqual(['parking:1', 'reviewing:2', 'investigations:1', 'devwork:2']);
    expect(roots(h.ui).map((n) => h.ui.tree.getTreeItem(n).label)).toEqual([
      'Parking lot (1)',
      'PRs we are reviewing (2)',
      'Investigations (1)',
      'My dev work (2)',
    ]);
  });

  it('puts the indicator in the label and the reasons in the tooltip', async () => {
    const h = await connected();
    const item = h.ui.tree.getTreeItem(rowOf(h.ui, 'reviewing', `session:${REVIEW_ID}`));
    expect(item.label).toBe('✅ Add rate limiting to the ingest endpoint');
    expect(item.tooltip).toContain('review_ready');
    expect(item.contextValue).toBe('reviewing:session:review');
    expect(item.command).toEqual({
      command: 'cgremlin.openItem',
      title: 'Open item',
      arguments: [rowOf(h.ui, 'reviewing', `session:${REVIEW_ID}`)],
    });
  });

  it('coalesces a burst of three refreshes into one onDidChangeTreeData fire', async () => {
    const h = await connected();
    const before = h.host.callsOf('treeDataChanged').length;
    h.ui.coordinator.schedule();
    h.ui.coordinator.schedule();
    h.ui.coordinator.schedule();
    h.host.flushTimeouts();
    await h.ui.coordinator.settled();
    expect(h.host.callsOf('treeDataChanged').length - before).toBe(1);
  });
});

describe('the status bar', () => {
  it('says no repo open until a session has been opened', async () => {
    const h = await connected();
    expect(h.host.statusBarItems[0].text).toBe('$(folder) cgremlin: no repo open — 4 need you');
  });

  it('names the opened session, its phase and the needs-you count', async () => {
    const h = await connected();
    h.host.workspaceFilePath = MANAGED;
    h.host.folders = [REVIEW_WORKTREE];
    await h.host.invoke('cgremlin.openItem', rowOf(h.ui, 'reviewing', `session:${REVIEW_ID}`));
    expect(h.host.statusBarItems[0].text).toBe(
      `$(pulse) cgremlin: ${REVIEW_ID} · ready — 4 need you`,
    );
    expect(h.host.statusBarItems[0].tooltip).toContain(REVIEW_WORKTREE);
  });

  it('counts the core needsYou flag, never needsAttention', async () => {
    // Every fixture item has needsAttention === needsYou, which would let a re-derivation from the
    // wrong field pass unnoticed — so this snapshot pulls the two apart (R22).
    const listing = fixtures.attention as { evaluatedAt: string; items: AttentionItem[] };
    const h = await connected({
      handler: (req) =>
        req.path === '/attention'
          ? {
              status: 200,
              body: {
                evaluatedAt: listing.evaluatedAt,
                items: listing.items.map((item, at) => ({
                  ...item,
                  attention: { ...item.attention, needsAttention: true, needsYou: at === 0 },
                })),
              },
            }
          : undefined,
    });
    expect(h.ui.coordinator.items().filter((i) => i.attention.needsAttention)).toHaveLength(
      listing.items.length,
    );
    expect(h.host.statusBarItems[0].text).toBe('$(folder) cgremlin: no repo open — 1 need you');
  });
});

describe('cgremlin.openItem', () => {
  it('previews the primary artifact, then swaps the single managed folder', async () => {
    const h = await connected();
    h.host.workspaceFilePath = MANAGED;
    h.host.folders = [`${STATE_DIR}/worktrees/some-other`];
    const mark = h.mark();
    await h.host.invoke('cgremlin.openItem', rowOf(h.ui, 'reviewing', `session:${REVIEW_ID}`));
    expect(h.since(mark).map((r) => r.path)).toEqual([`/sessions/${REVIEW_ID}/artifacts`]);
    const preview = h.host.callsOf('executeCommand').filter((c) => c.args[0] === 'markdown.showPreview');
    expect(preview).toHaveLength(1);
    expect((preview[0].args[1] as { fsPath: string }).fsPath).toBe(
      `${SESSIONS_DIR}/${REVIEW_ID}/REVIEW.md`,
    );
    const swaps = h.host.callsOf('updateWorkspaceFolders');
    expect(swaps).toHaveLength(1);
    expect(swaps[0].args).toEqual([0, 1, [{ uri: REVIEW_WORKTREE, name: REVIEW_ID }]]);
    expect(h.host.callsOf('showInformationMessage')).toHaveLength(1);
  });

  it('does nothing to the workspace when the worktree is already the only folder', async () => {
    const h = await connected();
    h.host.workspaceFilePath = MANAGED;
    h.host.folders = [REVIEW_WORKTREE];
    await h.host.invoke('cgremlin.openItem', rowOf(h.ui, 'reviewing', `session:${REVIEW_ID}`));
    expect(h.host.callsOf('updateWorkspaceFolders')).toEqual([]);
    expect(h.host.callsOf('showInformationMessage')).toEqual([]);
  });

  it('warns and previews nothing when the session has no primary artifact', async () => {
    const h = await connected({
      handler: (req) =>
        /\/artifacts$/.test(req.path) ? { status: 200, body: { artifacts: [], primary: null } } : undefined,
    });
    await h.host.invoke('cgremlin.openItem', rowOf(h.ui, 'reviewing', `session:${REVIEW_ID}`));
    const warnings = h.host.callsOf('showWarningMessage');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].args[0]).toContain(REVIEW_ID);
    expect(
      h.host.callsOf('executeCommand').filter((c) => c.args[0] === 'markdown.showPreview'),
    ).toEqual([]);
  });

  it('opens a sessionless parking row on GitHub instead of previewing', async () => {
    const h = await connected();
    const mark = h.mark();
    await h.host.invoke('cgremlin.openItem', rowOf(h.ui, 'parking', 'pr:acme/web#101'));
    expect(h.since(mark)).toEqual([]);
    expect(h.host.callsOf('openExternal').map((c) => c.args[0])).toEqual([
      'https://github.com/acme/web/pull/101',
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
    await h.host.invoke('cgremlin.openItem', rowOf(h.ui, 'reviewing', `session:${REVIEW_ID}`));
    const order = h.host.kinds().filter((k) => k === 'showWarningMessage' || k === 'updateWorkspaceFolders');
    expect(order).toEqual(['showWarningMessage', 'updateWorkspaceFolders']);
    const modal = h.host.callsOf('showWarningMessage')[0];
    expect(modal.args[1]).toEqual({ modal: true });
    expect(modal.args[2]).toEqual(['Switch anyway']);
    expect(h.host.callsOf('updateWorkspaceFolders')).toHaveLength(1);
  });

  it('leaves the workspace untouched when the modal is dismissed, and still previews', async () => {
    const h = await connected();
    h.host.workspaceFilePath = MANAGED;
    h.host.folders = [`${STATE_DIR}/worktrees/some-other`];
    h.host.dirty = [`${STATE_DIR}/worktrees/some-other/src/a.ts`];
    h.host.messageAnswers = [undefined];
    await h.host.invoke('cgremlin.openItem', rowOf(h.ui, 'reviewing', `session:${REVIEW_ID}`));
    expect(h.host.callsOf('updateWorkspaceFolders')).toEqual([]);
    expect(
      h.host.callsOf('executeCommand').filter((c) => c.args[0] === 'markdown.showPreview'),
    ).toHaveLength(1);
  });

  it('does not confirm when the dirty document is outside the folders being removed', async () => {
    const h = await connected();
    h.host.workspaceFilePath = MANAGED;
    h.host.folders = [`${STATE_DIR}/worktrees/some-other`];
    h.host.dirty = ['/somewhere/else/notes.md'];
    await h.host.invoke('cgremlin.openItem', rowOf(h.ui, 'reviewing', `session:${REVIEW_ID}`));
    expect(h.host.callsOf('showWarningMessage')).toEqual([]);
    expect(h.host.callsOf('updateWorkspaceFolders')).toHaveLength(1);
  });
});

describe('MG-B3 no-extension-host-restart (host half)', () => {
  it('writes the managed file once and opens it only after the user consents', async () => {
    const h = await connected();
    h.host.workspaceFilePath = undefined;
    h.host.messageAnswers = ['Open the cgremlin workspace'];
    await h.host.invoke('cgremlin.openItem', rowOf(h.ui, 'reviewing', `session:${REVIEW_ID}`));
    expect(h.host.callsOf('writeFile').map((c) => c.args[0])).toEqual([MANAGED]);
    expect(JSON.parse(h.host.files.get(MANAGED) as string).folders).toHaveLength(1);
    expect(h.host.callsOf('updateWorkspaceFolders')).toEqual([]);
    const opens = h.host.callsOf('executeCommand').filter((c) => c.args[0] === 'vscode.openFolder');
    expect(opens).toHaveLength(1);
    expect((opens[0].args[1] as { fsPath: string }).fsPath).toBe(MANAGED);

    // A second open does not rewrite a managed file that is already there.
    h.host.messageAnswers = [undefined];
    await h.host.invoke('cgremlin.openItem', rowOf(h.ui, 'reviewing', `session:${REVIEW_ID}`));
    expect(h.host.callsOf('writeFile')).toHaveLength(1);
  });

  it('opens nothing when the offer is dismissed, and still previews', async () => {
    const h = await connected();
    h.host.workspaceFilePath = undefined;
    h.host.messageAnswers = [undefined];
    await h.host.invoke('cgremlin.openItem', rowOf(h.ui, 'reviewing', `session:${REVIEW_ID}`));
    expect(
      h.host.callsOf('executeCommand').filter((c) => c.args[0] === 'vscode.openFolder'),
    ).toEqual([]);
    expect(
      h.host.callsOf('executeCommand').filter((c) => c.args[0] === 'markdown.showPreview'),
    ).toHaveLength(1);
  });
});

describe('MG-B4 chat-always-runs-in-the-worktree', () => {
  it('reads the conversation, claims it, then opens the terminal in the worktree', async () => {
    const h = await connected();
    const mark = h.mark();
    await h.host.invoke('cgremlin.chat', rowOf(h.ui, 'reviewing', `session:${REVIEW_ID}`));
    expect(h.since(mark).map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET /sessions/${REVIEW_ID}/conversation`,
      `POST /sessions/${REVIEW_ID}/conversation/claim`,
    ]);
    const created = h.host.callsOf('createTerminal');
    expect(created).toHaveLength(1);
    expect(created[0].args[0]).toEqual({
      name: `cgremlin: ${REVIEW_ID}`,
      cwd: REVIEW_WORKTREE,
    });
    expect(h.host.terminals[0].sent).toEqual([
      "claude --resume '7c3f9a10-2b4d-4e51-9f00-8a1b2c3d4e5f'",
    ]);
    // The claim is recorded before the terminal exists — a terminal without a claim is the bug.
    expect(h.host.kinds().indexOf('createTerminal')).toBeGreaterThan(-1);
  });

  it('shows a refused claim verbatim and creates no terminal', async () => {
    const h = await connected({
      handler: (req) =>
        req.path.endsWith('/conversation/claim')
          ? { status: 409, body: { error: "Session 'x' has a run in flight; stop it first" } }
          : undefined,
    });
    await h.host.invoke('cgremlin.chat', rowOf(h.ui, 'reviewing', `session:${REVIEW_ID}`));
    expect(h.host.callsOf('createTerminal')).toEqual([]);
    expect(h.host.callsOf('showWarningMessage')[0].args[0]).toBe(
      "Session 'x' has a run in flight; stop it first",
    );
  });

  it('releases the claim when the terminal closes', async () => {
    const h = await connected();
    await h.host.invoke('cgremlin.chat', rowOf(h.ui, 'reviewing', `session:${REVIEW_ID}`));
    const mark = h.mark();
    h.host.closeTerminal(h.host.terminals[0]);
    await h.ui.chat.settled();
    expect(h.since(mark).map((r) => r.path)).toEqual([`/sessions/${REVIEW_ID}/conversation/release`]);
  });

  it('R20 heartbeats at a third of the TTL from GET /config', async () => {
    const h = await connected();
    expect(heartbeatIntervalMs(600_000)).toBe(200_000);
    await h.host.invoke('cgremlin.chat', rowOf(h.ui, 'reviewing', `session:${REVIEW_ID}`));
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

  it('R20 stops heartbeating once the terminal is closed', async () => {
    const h = await connected();
    await h.host.invoke('cgremlin.chat', rowOf(h.ui, 'reviewing', `session:${REVIEW_ID}`));
    h.host.closeTerminal(h.host.terminals[0]);
    await h.ui.chat.settled();
    const mark = h.mark();
    h.host.advance(600_000);
    await h.ui.chat.settled();
    expect(h.since(mark)).toEqual([]);
  });

  it('R20 dispose releases every outstanding claim and clears its interval', async () => {
    const h = await connected();
    await h.host.invoke('cgremlin.chat', rowOf(h.ui, 'reviewing', `session:${REVIEW_ID}`));
    const mark = h.mark();
    await h.ui.dispose();
    uis.splice(uis.indexOf(h.ui), 1);
    expect(h.since(mark).map((r) => r.path)).toEqual([`/sessions/${REVIEW_ID}/conversation/release`]);
    h.host.advance(600_000);
    await h.ui.chat.settled();
    expect(h.since(mark)).toHaveLength(1);
  });
});

describe('the row commands', () => {
  it('offers startReview for parking and reviewing rows only', async () => {
    const h = await connected();
    const mark = h.mark();
    // A dev-work row that *does* carry a PR: the row kind is the only thing refusing here, so a
    // dropped kind guard cannot hide behind a missing pr link.
    const devRow = rowOf(h.ui, 'devwork', 'session:dev-acme-api-7');
    expect((devRow as { row: { item: { links: { prNumber: number | null } } } }).row.item.links.prNumber).toBe(7);
    await h.host.invoke('cgremlin.startReview', devRow);
    expect(h.since(mark)).toEqual([]);
    await h.host.invoke('cgremlin.startReview', rowOf(h.ui, 'investigations', 'session:inv-acme-web-7f3'));
    expect(h.since(mark)).toEqual([]);
    expect(h.host.callsOf('showWarningMessage')).toHaveLength(2);
    await h.host.invoke('cgremlin.startReview', rowOf(h.ui, 'parking', 'pr:acme/web#101'));
    expect(h.since(mark).map((r) => `${r.method} ${r.path}`)).toEqual(['POST /prs/acme/web/101/review']);
  });

  it('shows a 409 from startReview verbatim', async () => {
    const h = await connected({
      handler: (req) =>
        req.path.endsWith('/review')
          ? { status: 409, body: { error: 'PR acme/web#101 is authored by you' } }
          : undefined,
    });
    await h.host.invoke('cgremlin.startReview', rowOf(h.ui, 'parking', 'pr:acme/web#101'));
    expect(h.host.callsOf('showWarningMessage')[0].args[0]).toBe('PR acme/web#101 is authored by you');
  });

  it('each of approvePlan, stop, retry, ack and refreshInventory calls exactly one endpoint', async () => {
    const h = await connected();
    const inv = rowOf(h.ui, 'investigations', 'session:inv-acme-web-7f3');
    for (const [command, expected] of [
      ['cgremlin.approvePlan', 'POST /sessions/inv-acme-web-7f3/approve-plan'],
      ['cgremlin.stop', 'POST /sessions/inv-acme-web-7f3/stop'],
      ['cgremlin.retry', 'POST /sessions/inv-acme-web-7f3/retry'],
      ['cgremlin.ack', 'POST /attention/ack'],
    ] as const) {
      const mark = h.mark();
      await h.host.invoke(command, inv);
      expect(h.since(mark).map((r) => `${r.method} ${r.path}`)).toEqual([expected]);
    }
    const mark = h.mark();
    await h.host.invoke('cgremlin.refreshInventory');
    expect(h.since(mark).map((r) => `${r.method} ${r.path}`)).toEqual(['POST /prs/scan']);
  });

  it('acks by the generic item ref, so a PR row needs no session', async () => {
    const h = await connected();
    const mark = h.mark();
    await h.host.invoke('cgremlin.ack', rowOf(h.ui, 'parking', 'pr:acme/web#101'));
    expect(h.since(mark)).toEqual([
      { method: 'POST', path: '/attention/ack', body: { ref: 'pr:acme/web#101' } },
    ]);
  });

  it('surfaces a non-2xx body error verbatim for every row command', async () => {
    const h = await connected({
      handler: (req) =>
        req.method === 'POST' ? { status: 409, body: { error: 'nope, not now' } } : undefined,
    });
    await h.host.invoke('cgremlin.stop', rowOf(h.ui, 'investigations', 'session:inv-acme-web-7f3'));
    expect(h.host.callsOf('showWarningMessage')[0].args[0]).toBe('nope, not now');
  });

  it('binds refreshPreview to the built-in markdown preview refresh', async () => {
    const h = await connected();
    await h.host.invoke('cgremlin.refreshPreview');
    expect(
      h.host.callsOf('executeCommand').map((c) => c.args[0]),
    ).toContain('markdown.preview.refresh');
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
    expect(h.since(mark).map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /sessions/investigations',
      'POST /sessions/created/run',
      'GET /sessions/created/artifacts',
    ]);
    expect(h.since(mark)[0].body).toEqual({
      repoUrl: 'https://github.com/acme/api.git',
      ticket: 'ING-412',
      intent: 'development',
      driveToCompletion: true,
    });
    expect(h.since(mark)[1].body).toEqual({ stage: 'findings' });
  });

  it('aborts with no HTTP call when any step is dismissed', async () => {
    const h = await connected();
    const cases: { quickPick: (string | undefined)[]; inputBox: (string | undefined)[] }[] = [
      { quickPick: [undefined], inputBox: [] },
      { quickPick: ['acme/web'], inputBox: [undefined] },
      { quickPick: ['acme/web', undefined], inputBox: [''] },
      { quickPick: ['acme/web', 'Investigate only', undefined], inputBox: [''] },
    ];
    for (const c of cases) {
      h.host.quickPickAnswers = c.quickPick;
      h.host.inputBoxAnswers = c.inputBox;
      const mark = h.mark();
      await h.host.invoke('cgremlin.newInvestigation');
      expect(h.since(mark)).toEqual([]);
    }
  });

  it('sends a null ticket for empty input', async () => {
    const h = await connected();
    h.host.quickPickAnswers = ['acme/web', 'Investigate only', 'Stop at the plan'];
    h.host.inputBoxAnswers = [''];
    const mark = h.mark();
    await h.host.invoke('cgremlin.newInvestigation');
    expect(h.since(mark)[0].body).toEqual({
      repoUrl: 'https://github.com/acme/web.git',
      ticket: null,
      intent: 'investigate_only',
      driveToCompletion: false,
    });
  });

  it('validates the ticket with the same regex the API enforces', async () => {
    const h = await connected();
    h.host.quickPickAnswers = ['acme/web'];
    h.host.inputBoxAnswers = [undefined];
    await h.host.invoke('cgremlin.newInvestigation');
    const validate = h.host.lastValidateInput;
    expect(validate).toBeTypeOf('function');
    for (const bad of ['a/b', 'a b', 'a\\b', '../x']) {
      expect(validate?.(bad)).toBeTypeOf('string');
    }
    for (const good of ['ABC-1', 'a.b_c-1', '']) {
      expect(validate?.(good) ?? null).toBeNull();
    }
    expect(validateTicket('a/b')).toBeTypeOf('string');
    expect(validateTicket('ABC-1')).toBeNull();
  });
});

describe('cgremlin.newDevelopmentSession', () => {
  it('asks two questions, creates, runs develop once and opens the item', async () => {
    const h = await connected();
    h.host.quickPickAnswers = ['acme/api'];
    h.host.inputBoxAnswers = ['ING-9'];
    const mark = h.mark();
    await h.host.invoke('cgremlin.newDevelopmentSession');
    expect(h.host.callsOf('showQuickPick')[0].args[0]).toEqual(['acme/web', 'acme/api']);
    expect(h.since(mark).map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /sessions/developments',
      'POST /sessions/created/run',
      'GET /sessions/created/artifacts',
    ]);
    expect(h.since(mark)[0].body).toEqual({
      repoUrl: 'https://github.com/acme/api.git',
      ticket: 'ING-9',
    });
    expect(h.since(mark)[1].body).toEqual({ stage: 'develop' });
  });

  it('aborts on Esc at either step', async () => {
    const h = await connected();
    for (const c of [
      { quickPick: [undefined], inputBox: [] },
      { quickPick: ['acme/web'], inputBox: [undefined] },
    ]) {
      h.host.quickPickAnswers = c.quickPick;
      h.host.inputBoxAnswers = c.inputBox;
      const mark = h.mark();
      await h.host.invoke('cgremlin.newDevelopmentSession');
      expect(h.since(mark)).toEqual([]);
    }
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

  it('a 202 opens the new session', async () => {
    const h = await connected();
    h.host.inputBoxAnswers = ['https://github.com/o/r/pull/12'];
    const mark = h.mark();
    await h.host.invoke('cgremlin.newReviewFromUrl');
    expect(h.since(mark).map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /reviews',
      'GET /sessions/created/artifacts',
    ]);
    expect(h.since(mark)[0].body).toEqual({ prUrl: 'https://github.com/o/r/pull/12' });
  });

  it('a 200 with created:false reveals the existing session and posts nothing further', async () => {
    const h = await connected({
      handler: (req) =>
        req.path === '/reviews'
          ? {
              status: 200,
              body: { session: { id: 'pr-o-r-12' }, created: false, started: false },
            }
          : undefined,
    });
    h.host.inputBoxAnswers = ['https://github.com/o/r/pull/12'];
    const mark = h.mark();
    await h.host.invoke('cgremlin.newReviewFromUrl');
    expect(h.since(mark).map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /reviews',
      'GET /sessions/pr-o-r-12/artifacts',
    ]);
    expect(h.host.callsOf('showInformationMessage')).toHaveLength(1);
    expect(h.host.callsOf('showWarningMessage')).toEqual([]);
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
    expect(popups).toHaveLength(4);
    expect(popups[0].args[2]).toEqual(['Open', 'Ack']);
    expect(popups[0].args[0]).toContain('review_ready');
  });

  it('pops nothing at level off, and nothing for an unchanged snapshot', async () => {
    const items = h.ui.coordinator.items();
    h.ui.notifications.apply([], items, 'off');
    h.ui.notifications.apply(items, items, 'all');
    await h.ui.settled();
    expect(h.host.callsOf('showInformationMessage')).toEqual([]);
  });

  it('Open runs cgremlin.openItem for that ref and Ack posts the ack', async () => {
    h.host.messageAnswers = ['Open', 'Ack', undefined, undefined];
    const mark = h.mark();
    h.ui.notifications.apply([], h.ui.coordinator.items(), 'all');
    await h.ui.settled();
    const paths = h.since(mark).map((r) => r.path);
    expect(paths).toContain(`/sessions/${REVIEW_ID}/artifacts`);
    expect(paths).toContain('/attention/ack');
  });
});
