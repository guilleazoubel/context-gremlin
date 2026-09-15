/**
 * B3 — the Item tab: one panel, one worktree, the CSP of R38, the `ready` handshake of R39 and
 * the three focuses of R48.
 *
 * The tab is handed `{ scriptText, styleText }` as literals (R62), so nothing here depends on
 * `build:webview` having run, and a red test means the HTML is wrong rather than the bundle
 * missing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CoreClient } from '../../src/core-client';
import { ITEM_TAB_VIEW_TYPE, ItemTab, buttonsFor, cspFor } from '../../src/ui/item-tab';
import { WorktreeSwapper } from '../../src/ui/preview';
import { FakeHost, type FakeWebviewPanel } from '../support/fake-host';
import { startStubServer, type StubServerHandle } from '../support/stub-server';
import itemsFixture from '../support/fixtures/items.json';
import type { ItemsResponse, WorkItem } from '../../src/model/work-items';
import type { ItemTabState } from '../../src/model/item-tab-protocol';

const STATE_DIR = '/tmp/cgremlin-fixture';
const MEDIA = '/ext/media';
const SCRIPT = 'globalThis.__cgremlin_panel = 1;';
const STYLE = 'body { color: var(--vscode-foreground); }';

const servers: StubServerHandle[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.dispose();
});

function fixture(): ItemsResponse {
  return JSON.parse(JSON.stringify(itemsFixture)) as ItemsResponse;
}

function itemOf(id: string): WorkItem {
  const found = fixture().items.find((i) => i.id === id);
  if (found === undefined) throw new Error(`no fixture item ${id}`);
  return found;
}

const ARTIFACTS: Record<string, { name: string; mtime: string; size: number }[]> = {
  'pr-acme-web-102': [
    { name: 'BRIEF.md', mtime: '2026-09-10T08:00:00.000Z', size: 10 },
    { name: 'REVIEW.md', mtime: '2026-09-10T08:20:00.000Z', size: 20 },
  ],
  'inv-hb-627': [{ name: 'PLAN.md', mtime: '2026-09-10T07:00:00.000Z', size: 30 }],
  'dev-hb-627': [{ name: 'NOTES.md', mtime: '2026-09-10T06:00:00.000Z', size: 40 }],
  'respond-acme-web-200': [],
};

function detailFor(id: string): unknown {
  const item = itemOf(id);
  const artifacts: Record<string, unknown> = {};
  for (const agent of item.agents) artifacts[agent.sessionId] = ARTIFACTS[agent.sessionId] ?? [];
  return {
    item,
    ticket:
      item.ticket === null
        ? null
        : {
            key: item.ticket.key,
            summary: item.ticket.summary,
            status: item.ticket.status,
            statusCategory: item.ticket.statusCategory,
            assignee: item.ticket.assignee,
            updated: item.ticket.updatedAt,
            url: item.ticket.url,
            descriptionText: 'A <b>bold</b> description, already flattened to text.',
            comments: [{ author: 'dana', at: '2026-09-09T10:00:00.000Z', bodyText: 'looks good' }],
          },
    ticketError: null,
    artifacts,
  };
}

const PATHS: Record<string, string> = {
  '/items/pr/acme/web/102': 'pr:acme/web#102',
  '/items/ticket/HB-627': 'ticket:HB-627',
  '/items/pr/acme/web/310': 'ticket:HB-627',
  '/items/pr/acme/web/200': 'pr:acme/web#200',
  '/items/pr/acme/web/101': 'pr:acme/web#101',
  '/items/session/inv-hb-627': 'ticket:HB-627',
};

interface Harness {
  host: FakeHost;
  tab: ItemTab;
  server: StubServerHandle;
  panel(): FakeWebviewPanel;
  paths(mark?: number): string[];
  mark(): number;
  /** The webview says it is listening (R39). */
  ready(): void;
  state(): ItemTabState;
}

async function harness(options: { folders?: string[]; dirty?: string[] } = {}): Promise<Harness> {
  const server = await startStubServer({
    handler: (req) => {
      const id = PATHS[req.path];
      if (req.method === 'GET' && id !== undefined) return { status: 200, body: detailFor(id) };
      if (req.method === 'GET' && /^\/sessions\/[^/]+\/artifacts\/[^/]+$/.test(req.path)) {
        return { status: 200, body: `# ${req.path.split('/').pop()}\n\nbody text` };
      }
      return undefined;
    },
  });
  servers.push(server);
  const host = new FakeHost();
  host.folders = options.folders ?? [];
  host.dirty = options.dirty ?? [];
  host.workspaceFilePath = `${STATE_DIR}/cgremlin.code-workspace`;
  const client = new CoreClient(server.socketPath);
  const config = () => ({ stateDir: STATE_DIR, sessionsDir: `${STATE_DIR}/sessions` }) as never;
  const tab = new ItemTab({
    host,
    client,
    config,
    assets: { scriptText: SCRIPT, styleText: STYLE },
    mediaPath: MEDIA,
    swapper: new WorktreeSwapper({ host, config }),
    onOpened: () => undefined,
    nonce: () => `nonce-${host.panels.length}-${Math.random().toString(36).slice(2, 8)}`,
  });
  return {
    host,
    tab,
    server,
    panel: () => {
      const panel = host.panels[host.panels.length - 1];
      if (panel === undefined) throw new Error('no panel was created');
      return panel;
    },
    mark: () => server.requests.length,
    paths: (mark = 0) => server.requests.slice(mark).map((r) => `${r.method} ${r.path}`),
    ready: () => {
      for (const panel of host.panels) panel.webview.emit({ type: 'ready' });
    },
    state: () => {
      const panel = host.panels[host.panels.length - 1];
      const render = [...panel.webview.posted]
        .reverse()
        .find((m) => (m as { type?: string }).type === 'render') as
        | { type: 'render'; state: ItemTabState }
        | undefined;
      if (render === undefined) throw new Error('nothing rendered');
      return render.state;
    },
  };
}

// ---------------------------------------------------------------------------

describe('MG-B9 one item tab and one worktree', () => {
  it('reuses the one panel across items, and creates one more only after a dispose', async () => {
    const h = await harness();
    await h.tab.open('pr/acme/web/102');
    h.ready();
    await h.tab.open('ticket/HB-627');
    expect(h.host.panels).toHaveLength(1);
    expect(h.panel().revealed).toBeGreaterThanOrEqual(1);

    h.panel().dispose();
    await h.tab.open('pr/acme/web/102');
    expect(h.host.panels).toHaveLength(2);
  });

  it('opens a ticket child then a PR child in the SAME panel (R48)', async () => {
    const h = await harness();
    await h.tab.open('ticket/HB-627', { kind: 'ticket' });
    h.ready();
    await h.tab.open('pr/acme/web/310', { kind: 'pr', repo: 'acme/web', number: 310 });
    expect(h.host.panels).toHaveLength(1);
    expect(h.state().focus).toEqual({ kind: 'pr', repo: 'acme/web', number: 310 });
  });

  it('swaps the workspace to the selected agent, at most one updateWorkspaceFolders', async () => {
    const h = await harness({ folders: ['/tmp/cgremlin-fixture/worktrees/old'] });
    await h.tab.open('ticket/HB-627');
    h.ready();
    expect(h.host.callsOf('updateWorkspaceFolders')).toHaveLength(1);
    await h.tab.selectAgent('dev-hb-627');
    expect(h.host.callsOf('updateWorkspaceFolders')).toHaveLength(2);
    expect(h.host.folders).toEqual(['/tmp/cgremlin-fixture/worktrees/dev-hb-627']);
  });

  it('leaves the workspace alone for an item with no agent at all (R22)', async () => {
    const h = await harness({ folders: ['/tmp/cgremlin-fixture/worktrees/old'] });
    await h.tab.open('pr/acme/web/101');
    h.ready();
    expect(h.host.callsOf('updateWorkspaceFolders')).toEqual([]);
  });

  it('still gates the swap behind the dirty-editor modal (Phase 7 MG-B5)', async () => {
    const h = await harness({
      folders: ['/tmp/cgremlin-fixture/worktrees/old'],
      dirty: ['/tmp/cgremlin-fixture/worktrees/old/src/a.ts'],
    });
    h.host.messageAnswers = [undefined];
    await h.tab.open('ticket/HB-627');
    const warning = h.host.callsOf('showWarningMessage')[0];
    expect(warning.args[1]).toEqual({ modal: true });
    expect(h.host.callsOf('updateWorkspaceFolders')).toEqual([]);
  });

  it('R42 — switching agents twice records zero claim and zero release calls', async () => {
    const h = await harness();
    await h.tab.open('ticket/HB-627');
    h.ready();
    const mark = h.mark();
    await h.tab.selectAgent('dev-hb-627');
    await h.tab.selectAgent('inv-hb-627');
    const claims = h.paths(mark).filter((p) => /claim|release/.test(p));
    expect(claims).toEqual([]);
  });
});

describe('MG-B7 the host half: the CSP, the roots and the injected text', () => {
  it('creates the panel with scripts, retained context and only media as a root', async () => {
    const h = await harness();
    await h.tab.open('pr/acme/web/102');
    const options = h.host.callsOf('createWebviewPanel')[0].args[0] as {
      viewType: string;
      enableScripts: boolean;
      retainContextWhenHidden: boolean;
      localResourceRoots: string[];
    };
    expect(options.viewType).toBe(ITEM_TAB_VIEW_TYPE);
    expect(options.enableScripts).toBe(true);
    expect(options.retainContextWhenHidden).toBe(true);
    expect(options.localResourceRoots).toEqual([MEDIA]);
  });

  it('writes R38’s CSP byte-for-byte, with a fresh nonce and no unsafe-inline', async () => {
    const h = await harness();
    await h.tab.open('pr/acme/web/102');
    const html = h.panel().webview.html;
    const nonce = /script-src 'nonce-([^']+)'/.exec(html)?.[1];
    expect(nonce).toBeTypeOf('string');
    expect(html).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${cspFor(nonce as string)}">`,
    );
    expect(cspFor('N')).toBe(
      "default-src 'none'; script-src 'nonce-N'; style-src 'nonce-N'; img-src 'none'; font-src 'none'",
    );
    expect(html).not.toContain('unsafe-inline');
    expect(html).not.toContain('cspSource');
  });

  it('inlines the injected script and style text, and loads nothing by URI', async () => {
    const h = await harness();
    await h.tab.open('pr/acme/web/102');
    const html = h.panel().webview.html;
    expect(html).toContain(SCRIPT);
    expect(html).toContain(STYLE);
    expect(html).toMatch(/<script nonce="[^"]+">/);
    expect(html).toMatch(/<style nonce="[^"]+">/);
    expect(html).not.toContain('src=');
    expect(html).not.toContain('vscode-resource');
  });

  it('R62 — the module reads no file and names no media path', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/ui/item-tab.ts'), 'utf8');
    expect(source).not.toMatch(/readFile/);
    expect(source).not.toMatch(/media\//);
  });
});

describe('R39 the ready handshake', () => {
  it('posts no render until the webview says it is listening, then exactly one', async () => {
    const h = await harness();
    await h.tab.open('pr/acme/web/102');
    expect(h.panel().webview.renders()).toEqual([]);
    h.ready();
    expect(h.panel().webview.renders()).toHaveLength(1);
  });

  it('renders again on a re-created panel, in reply to its own ready', async () => {
    const h = await harness();
    await h.tab.open('pr/acme/web/102');
    h.ready();
    h.panel().dispose();
    await h.tab.open('pr/acme/web/102');
    expect(h.host.panels[1].webview.renders()).toEqual([]);
    h.host.panels[1].webview.emit({ type: 'ready' });
    expect(h.host.panels[1].webview.renders()).toHaveLength(1);
  });

  it('ignores a message it does not recognise (R21)', async () => {
    const h = await harness();
    await h.tab.open('pr/acme/web/102');
    h.panel().webview.emit({ type: 'nope' });
    h.panel().webview.emit('ready');
    expect(h.panel().webview.renders()).toEqual([]);
  });
});

describe('the artifacts', () => {
  it('sends their content over postMessage, newest first, never a file URI', async () => {
    const h = await harness();
    await h.tab.open('pr/acme/web/102');
    h.ready();
    await h.tab.settled();
    const state = h.state();
    expect(state.agents[0].artifacts.map((a) => a.name)).toEqual(['REVIEW.md', 'BRIEF.md']);
    const patches = h.panel().webview.posted.filter(
      (m) => (m as { type?: string }).type === 'patch',
    ) as { artifact: { name: string; text: string | null } }[];
    expect(patches.map((p) => p.artifact.name).sort()).toEqual(['BRIEF.md', 'REVIEW.md']);
    expect(patches[0].artifact.text).toContain('body text');
    expect(JSON.stringify(h.panel().webview.posted)).not.toContain('file://');
  });

  it('R41 — an artifact.changed for an agent of this item patches just that artifact', async () => {
    const h = await harness();
    await h.tab.open('pr/acme/web/102');
    h.ready();
    await h.tab.settled();
    const mark = h.mark();
    await h.tab.artifactChanged('pr-acme-web-102', 'REVIEW.md');
    expect(h.paths(mark)).toEqual(['GET /sessions/pr-acme-web-102/artifacts/REVIEW.md']);
    await h.tab.artifactChanged('some-other-session', 'REVIEW.md');
    expect(h.paths(mark)).toHaveLength(1);
  });

  it('R41/R36 — an item.changed for THIS item refetches the item and no artifact body', async () => {
    const h = await harness();
    await h.tab.open('pr/acme/web/102');
    h.ready();
    await h.tab.settled();
    const mark = h.mark();
    await h.tab.itemChanged('pr:acme/web#102');
    expect(h.paths(mark)).toEqual(['GET /items/pr/acme/web/102']);
    await h.tab.itemChanged('ticket:HB-627');
    expect(h.paths(mark)).toHaveLength(1);
  });
});

describe('R48 the three focuses', () => {
  it('an agent focus selects that agent and renders its artifacts', async () => {
    const h = await harness();
    await h.tab.open('ticket/HB-627', { kind: 'agent', sessionId: 'dev-hb-627' });
    h.ready();
    await h.tab.settled();
    const state = h.state();
    expect(state.selectedSessionId).toBe('dev-hb-627');
    expect(state.agents.find((a) => a.sessionId === 'dev-hb-627')?.artifacts[0].name).toBe(
      'NOTES.md',
    );
    expect(state.focus).toEqual({ kind: 'artifact', sessionId: 'dev-hb-627', name: 'NOTES.md' });
  });

  it('a ticket focus carries the ticket, as TEXT (R33)', async () => {
    const h = await harness();
    await h.tab.open('ticket/HB-627', { kind: 'ticket' });
    h.ready();
    const state = h.state();
    expect(state.focus).toEqual({ kind: 'ticket' });
    expect(state.ticket?.key).toBe('HB-627');
    expect(JSON.stringify(state)).not.toContain('Html');
  });

  it('a PR focus carries the PR info block', async () => {
    const h = await harness();
    await h.tab.open('pr/acme/web/310', { kind: 'pr', repo: 'acme/web', number: 310 });
    h.ready();
    const pr = h.state().prs.find((p) => p.number === 310);
    expect(pr?.state).toBe('approved');
    expect(pr?.ci).toBe('●');
    expect(pr?.changedFiles).toBe(12);
  });

  it('falls back to the primary agent on an unknown focus rather than rendering blank', async () => {
    const h = await harness();
    await h.tab.open('ticket/HB-627', { kind: 'agent', sessionId: 'not-an-agent' });
    h.ready();
    const state = h.state();
    expect(state.selectedSessionId).toBe('inv-hb-627');
    // Phase 17 §1: the fallback goes one step further than the agent — it opens the pane on that
    // agent's primary artifact, because an agent is not a document and a tab shows a document.
    expect(state.focus).toEqual({ kind: 'artifact', sessionId: 'inv-hb-627', name: 'PLAN.md' });
  });
});

describe('R42/R51 the button row', () => {
  const tabState = (item: WorkItem, selected: string | null): ItemTabState =>
    ({
      itemId: item.id,
      title: item.title,
      needsYou: item.needsYou,
      lists: item.lists,
      chips: [],
      focus: { kind: 'ticket' },
      selectedSessionId: selected,
      agents: item.agents.map((a) => ({
        sessionId: a.sessionId,
        mode: a.mode,
        phase: a.phase,
        running: a.running,
        needsYou: a.needsYou,
        claimed: a.claimed,
        glyph: '',
        primaryArtifact: a.primaryArtifact,
        artifacts: [],
      })),
      prs: item.prs.map((pr) => ({
        repo: pr.repo,
        number: pr.number,
        url: pr.url,
        title: pr.title,
        state: 'open',
        reviewDecision: pr.reviewDecision,
        ci: '',
        isMine: pr.isMine,
        isDraft: pr.isDraft,
        changedFiles: pr.changedFiles,
        additions: pr.additions,
        deletions: pr.deletions,
        reviewers: [],
        checks: [],
        openThreads: null,
      })),
      ticket: null,
      ticketError: null,
      buttons: [],
      parts: [],
    }) as unknown as ItemTabState;

  it('offers Start review on a teammate PR, and only a SELF-review on mine', () => {
    const teammate = buttonsFor(tabState(itemOf('pr:acme/web#101'), null));
    expect(teammate.map((b) => b.label)).toContain('Start review');
    // My own PR is past the development stage, so the forward-only ladder offers the review of
    // my own work — labelled as such, never the teammate wording the core would 409 on.
    const mine = buttonsFor(tabState(itemOf('pr:acme/web#200'), 'respond-acme-web-200'));
    expect(mine.map((b) => b.label)).not.toContain('Start review');
    expect(mine.map((b) => b.label)).toContain('Start self-review');
  });

  it('offers "Address review comments" exactly when the PR is mine and not a draft (R51)', () => {
    // #200 is mine and waiting for review, but a respond agent is already on it — a SECOND
    // respond run is the nonsensical session P0-2 exists to stop, so the button is gone.
    const withRespondAgent = itemOf('pr:acme/web#200');
    expect(buttonsFor(tabState(withRespondAgent, null)).map((b) => b.label)).not.toContain(
      'Address review comments',
    );
    const mine = JSON.parse(JSON.stringify(withRespondAgent)) as WorkItem;
    mine.agents = [];
    expect(buttonsFor(tabState(mine, null)).map((b) => b.label)).toContain(
      'Address review comments',
    );
    const draft = JSON.parse(JSON.stringify(mine)) as WorkItem;
    draft.prs[0].isDraft = true;
    expect(buttonsFor(tabState(draft, null)).map((b) => b.label)).not.toContain(
      'Address review comments',
    );
    expect(buttonsFor(tabState(itemOf('pr:acme/web#101'), null)).map((b) => b.label)).not.toContain(
      'Address review comments',
    );
  });

  it('P0-2 — the tab never offers a verb the row would refuse', () => {
    // The tab shares `model/row-actions`, so the parking lot's hard list holds here too.
    const teammate = buttonsFor(tabState(itemOf('pr:acme/web#101'), null)).map((b) => b.id);
    expect(teammate).not.toContain('cgremlin.startDevelopment');
    expect(teammate).not.toContain('cgremlin.startInvestigation');
    // …and Ack is no longer unconditional.
    expect(teammate).not.toContain('cgremlin.ack');
    expect(buttonsFor(tabState(itemOf('ticket:HB-627'), null)).map((b) => b.id)).toContain(
      'cgremlin.ack',
    );
  });

  it('R50 — Chat is disabled on a respond agent at triaging and enabled once it is addressing', () => {
    const item = itemOf('pr:acme/web#200');
    const triaging = buttonsFor(tabState(item, 'respond-acme-web-200')).find(
      (b) => b.id === 'cgremlin.chat',
    );
    expect(triaging?.enabled).toBe(false);
    expect(triaging?.reason).toBeTypeOf('string');

    const addressing = JSON.parse(JSON.stringify(item)) as WorkItem;
    addressing.agents[0].phase = 'addressing';
    expect(
      buttonsFor(tabState(addressing, 'respond-acme-web-200')).find((b) => b.id === 'cgremlin.chat')
        ?.enabled,
    ).toBe(true);
  });

  it('renders a respond agent in the switcher with its phase', async () => {
    const h = await harness();
    await h.tab.open('pr/acme/web/200');
    h.ready();
    const agent = h.state().agents[0];
    expect(agent.mode).toBe('respond');
    expect(agent.phase).toBe('triaging');
    expect(agent.glyph).toBe('🔄');
  });
});
