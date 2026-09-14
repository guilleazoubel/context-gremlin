/**
 * B4 — the side panel is a `WebviewViewProvider` (R54), and the tree is gone.
 *
 * Like the Item tab it is handed `{ scriptText, styleText }` as literals (R62), so none of this
 * depends on `build:webview` having run.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PANEL_VIEW_ID, PanelView } from '../../src/ui/panel-view';
import { handleKey, panelTreeNodes } from '../../src/model/panel-tree';
import { cspFor } from '../../src/ui/item-tab';
import { FakeHost, FakeWebviewView } from '../support/fake-host';
import itemsFixture from '../support/fixtures/items.json';
import type { ItemsResponse } from '../../src/model/work-items';
import type { PanelState } from '../../src/model/panel-protocol';

const root = path.resolve(__dirname, '../..');
const MEDIA = '/ext/media';
const SCRIPT = 'globalThis.__cgremlin_panel = 1;';
const STYLE = '.row { color: var(--vscode-foreground); }';

function response(): ItemsResponse {
  return JSON.parse(JSON.stringify(itemsFixture)) as ItemsResponse;
}

interface Built {
  host: FakeHost;
  panel: PanelView;
  view: FakeWebviewView;
  opened: string[];
  children: [string, string][];
  commands: [string, string, string | undefined][];
  state(): PanelState;
  ready(): void;
}

function build(over: { response?: ItemsResponse | null } = {}): Built {
  const host = new FakeHost();
  const opened: string[] = [];
  const children: [string, string][] = [];
  const commands: [string, string, string | undefined][] = [];
  const panel = new PanelView({
    host,
    assets: { scriptText: SCRIPT, styleText: STYLE },
    mediaPath: MEDIA,
    onOpenItem: (id) => {
      opened.push(id);
    },
    onOpenChild: (id, childId) => {
      children.push([id, childId]);
    },
    onCommand: (command, id, childId) => {
      commands.push([command, id, childId]);
    },
    now: () => Date.parse('2026-09-10T12:00:00.000Z'),
    nonce: () => 'test-nonce',
  });
  const view = new FakeWebviewView();
  panel.resolveWebviewView(view);
  const payload = over.response === undefined ? response() : over.response;
  if (payload !== null) panel.setItems(payload);
  panel.setConnected(true);
  return {
    host,
    panel,
    view,
    opened,
    children,
    commands,
    ready: () => view.webview.emit({ type: 'ready' }),
    state: () => {
      const render = [...view.webview.posted]
        .reverse()
        .find((m) => (m as { type?: string }).type === 'render') as
        | { state: PanelState }
        | undefined;
      if (render === undefined) throw new Error('nothing rendered');
      return render.state;
    },
  };
}

function everyFileUnder(dir: string, keep: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...everyFileUnder(full, keep));
    else if (keep(entry.name)) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------

describe('MG-B8 four lists and no tree', () => {
  const sources = everyFileUnder(path.join(root, 'src'), (n) => n.endsWith('.ts'));
  const text = sources.map((file) => [file, fs.readFileSync(file, 'utf8')] as const);

  function hits(needle: RegExp): string[] {
    return text
      .filter(([, source]) => needle.test(source))
      .map(([file]) => path.relative(root, file));
  }

  it('has no repo-wide PR list, no markdown preview and no tree left under src', () => {
    expect(hits(/client\.prs\(/)).toEqual([]);
    expect(hits(/markdown\.showPreview/)).toEqual([]);
    expect(hits(/markdown\.preview\.refresh/)).toEqual([]);
    expect(hits(/cgremlin\.refreshPreview/)).toEqual([]);
    expect(hits(/TreeDataProvider|createTreeView/)).toEqual([]);
    expect(fs.existsSync(path.join(root, 'src/ui/tree.ts'))).toBe(false);
  });

  it('contributes the view as a webview and no longer contributes refreshPreview', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      contributes: {
        views: { cgremlin: { id: string; type?: string }[] };
        commands: { command: string }[];
      };
    };
    const view = manifest.contributes.views.cgremlin.find((v) => v.id === PANEL_VIEW_ID);
    expect(view?.type).toBe('webview');
    expect(manifest.contributes.commands.map((c) => c.command)).not.toContain(
      'cgremlin.refreshPreview',
    );
  });

  it('renders exactly the four lists, in R47 order', () => {
    const h = build();
    h.ready();
    expect(h.state().lists.map((list) => list.kind)).toEqual([
      'parkingLot',
      'myWork',
      'investigations',
      'waitingForReview',
    ]);
    // `reviewing` survives only as the parking lot's first GROUP, never as a list of its own.
    expect(JSON.stringify(h.state().lists)).not.toContain('"kind":"reviewing"');
    expect(h.state().lists[0].sections[0].group).toBe('reviewing');
  });
});

describe('MG-B7 the panel half: the CSP, the roots and the escaping', () => {
  it('writes R38’s CSP byte-for-byte with its own nonce, and names only media as a root', () => {
    const h = build();
    expect(h.view.webview.html).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${cspFor('test-nonce')}">`,
    );
    expect(h.view.webview.html).not.toContain('unsafe-inline');
    expect(h.view.webview.html).not.toContain('cspSource');
    expect(h.view.webview.options?.localResourceRoots).toEqual([MEDIA]);
    expect(h.view.webview.options?.enableScripts).toBe(true);
  });

  it('inlines the injected script and style text (R62) and reads no file itself', () => {
    const h = build();
    expect(h.view.webview.html).toContain(SCRIPT);
    expect(h.view.webview.html).toContain(STYLE);
    const source = fs.readFileSync(path.join(root, 'src/ui/panel-view.ts'), 'utf8');
    expect(source).not.toMatch(/readFile/);
    expect(source).not.toMatch(/media\//);
  });

  it('keeps a PR title carrying markup as data, never as markup', () => {
    const payload = response();
    const item = payload.items.find((i) => i.id === 'pr:acme/web#101');
    if (item === undefined) throw new Error('fixture');
    item.prs[0].title = '<script>alert(1)</script>" onmouseover="alert(2)';
    const h = build({ response: payload });
    h.ready();
    const row = h
      .state()
      .lists.flatMap((list) => list.sections.flatMap((s) => s.rows))
      .find((r) => r.id === 'pr:acme/web#101');
    // The row crosses the channel as DATA: the webview sets it with textContent, and no HTML is
    // built on this side at all.
    expect(row?.label).toContain('<script>');
    expect(h.view.webview.html).not.toContain('<script>alert(1)');
  });
});

describe('R54 the ready handshake', () => {
  it('posts no render until the view says it is listening', () => {
    const h = build();
    expect(h.view.webview.posted).toEqual([]);
    h.ready();
    expect(h.view.webview.posted.filter((m) => (m as { type: string }).type === 'render')).toHaveLength(
      1,
    );
  });

  it('renders again for a re-created view, in reply to its own ready', () => {
    const h = build();
    h.ready();
    const second = new FakeWebviewView();
    h.panel.resolveWebviewView(second);
    expect(second.webview.posted).toEqual([]);
    second.webview.emit({ type: 'ready' });
    expect(second.webview.posted.filter((m) => (m as { type: string }).type === 'render')).toHaveLength(
      1,
    );
  });

  it('ignores a message it does not recognise', () => {
    const h = build();
    h.ready();
    h.view.webview.emit({ type: 'openItem' });
    h.view.webview.emit({ type: 'nope', id: 'x' });
    h.view.webview.emit('openItem');
    expect(h.opened).toEqual([]);
  });
});

describe('R54 the messages the panel acts on', () => {
  it('opens an item and a child by id', () => {
    const h = build();
    h.ready();
    h.view.webview.emit({ type: 'openItem', id: 'pr:acme/web#101' });
    h.view.webview.emit({ type: 'openChild', id: 'ticket:HB-627', childId: 'pr:acme/web#310' });
    expect(h.opened).toEqual(['pr:acme/web#101']);
    expect(h.children).toEqual([['ticket:HB-627', 'pr:acme/web#310']]);
  });

  it('forwards a row command with its id, and never with a payload of its own', () => {
    const h = build();
    h.ready();
    h.view.webview.emit({ type: 'command', command: 'cgremlin.ack', id: 'pr:acme/web#101' });
    expect(h.commands).toEqual([['cgremlin.ack', 'pr:acme/web#101', undefined]]);
  });

  it('R64 — a sort selection persists through the host state and survives a re-created view', () => {
    const h = build();
    h.ready();
    h.view.webview.emit({ type: 'setSort', list: 'parkingLot', sort: 'smallestChange' });
    expect(h.host.state.get('cgremlin.sort.parkingLot')).toBe('smallestChange');
    expect(h.state().lists[0].sort).toBe('smallestChange');

    const second = new FakeWebviewView();
    h.panel.resolveWebviewView(second);
    second.webview.emit({ type: 'ready' });
    const render = second.webview.posted.find(
      (m) => (m as { type: string }).type === 'render',
    ) as { state: PanelState };
    expect(render.state.lists[0].sort).toBe('smallestChange');
  });

  it('R47 — the sort reorders within the parking lot’s groups, never across them', () => {
    const h = build();
    h.ready();
    h.view.webview.emit({ type: 'setSort', list: 'parkingLot', sort: 'smallestChange' });
    const parking = h.state().lists[0];
    expect(parking.sections.map((s) => s.group)).toEqual([
      'reviewing',
      'untouched',
      'someoneOnIt',
    ]);
    expect(parking.sections[2].rows.map((r) => r.id)).toEqual(['pr:acme/api#55']);
    // #56 is an L and #101 an M, so the smallest-change order inside `untouched` is 101 then 56
    // — the sort really did move a row that changed group, and never across the group boundary.
    expect(parking.sections[1].rows.map((r) => r.id)).toEqual([
      'pr:acme/web#101',
      'pr:acme/api#56',
      'pr:acme/legacy#9',
    ]);
  });

  it('R47 — the "someone is on it" group is collapsed by default and toggles', () => {
    const h = build();
    h.ready();
    const collapsed = () => h.state().lists[0].sections.map((s) => s.collapsed);
    expect(collapsed()).toEqual([false, false, true]);
    h.view.webview.emit({
      type: 'toggleGroup',
      list: 'parkingLot',
      group: 'someoneOnIt',
      collapsed: false,
    });
    expect(collapsed()).toEqual([false, false, false]);
  });

  it('R48 — a row expands to its children, and the expansion survives a re-render', () => {
    const h = build();
    h.ready();
    const hb = () =>
      h
        .state()
        .lists.flatMap((l) => l.sections.flatMap((s) => s.rows))
        .find((r) => r.id === 'ticket:HB-627');
    expect(hb()?.expanded).toBe(false);
    expect(hb()?.hasChildren).toBe(true);
    h.view.webview.emit({ type: 'toggleRow', id: 'ticket:HB-627', expanded: true });
    expect(hb()?.expanded).toBe(true);
    // The PARTS only. The agents are the three lifecycle slots instead, so a session is never
    // listed twice in one expanded row (§4, amended).
    expect(hb()?.children.map((c) => c.kind)).toEqual(['ticket', 'pr', 'pr']);
    expect(hb()?.lifecycle.map((slot) => slot.stage)).toEqual([
      'investigation',
      'development',
      'review',
    ]);
    h.panel.setItems(response());
    expect(hb()?.expanded).toBe(true);
  });
});

describe('R42/R51/P0-2 the row actions are a rule about the LIST', () => {
  function rowIn(h: Built, list: string, id: string) {
    return h
      .state()
      .lists.find((l) => l.kind === list)
      ?.sections.flatMap((s) => s.rows)
      .find((r) => r.id === id);
  }

  function actionsOf(h: Built, list: string, id: string): string[] {
    return (rowIn(h, list, id)?.actions ?? []).map((a) => a.command);
  }

  it('offers Start review on a teammate PR with no review agent, and never on mine', () => {
    const h = build();
    h.ready();
    expect(actionsOf(h, 'parkingLot', 'pr:acme/web#101')).toContain('cgremlin.startReview');
    expect(actionsOf(h, 'parkingLot', 'pr:acme/web#102')).not.toContain('cgremlin.startReview');
    expect(actionsOf(h, 'waitingForReview', 'pr:acme/web#200')).not.toContain(
      'cgremlin.startReview',
    );
  });

  it('P0-2 — a parking-lot row offers Start review, Open PR and nothing else', () => {
    const h = build();
    h.ready();
    expect(actionsOf(h, 'parkingLot', 'pr:acme/web#101')).toEqual([
      'cgremlin.startReview',
      'cgremlin.openPr',
    ]);
  });

  it('P0-2 — no list offers Start development or Start investigation on somebody else’s PR', () => {
    const h = build();
    h.ready();
    const every = h.state().lists.flatMap((l) => l.sections.flatMap((s) => s.rows));
    const parking = every.filter((r) => r.list === 'parkingLot');
    expect(parking.length).toBeGreaterThan(0);
    for (const row of parking) {
      const commands = row.actions.map((a) => a.command);
      expect(commands, row.id).not.toContain('cgremlin.startDevelopment');
      expect(commands, row.id).not.toContain('cgremlin.startInvestigation');
    }
  });

  it('offers "Address review comments" on my own non-draft PR with no respond agent (R51)', () => {
    const h = build();
    h.ready();
    // HB-627 is mine, waiting for review, and has no respond agent yet.
    expect(actionsOf(h, 'waitingForReview', 'ticket:HB-627')).toContain('cgremlin.addressReview');
    // #200 already has one — a second respond run is exactly the nonsensical session P0-2 kills.
    expect(actionsOf(h, 'waitingForReview', 'pr:acme/web#200')).not.toContain(
      'cgremlin.addressReview',
    );
    expect(actionsOf(h, 'parkingLot', 'pr:acme/web#101')).not.toContain('cgremlin.addressReview');
  });

  it('R50 — Chat is offered on a respond agent only from addressing onwards', () => {
    const h = build();
    h.ready();
    expect(actionsOf(h, 'waitingForReview', 'pr:acme/web#200')).not.toContain('cgremlin.chat');

    const payload = response();
    const item = payload.items.find((i) => i.id === 'pr:acme/web#200');
    if (item === undefined) throw new Error('fixture');
    item.agents[0].phase = 'addressing';
    const later = build({ response: payload });
    later.ready();
    expect(actionsOf(later, 'waitingForReview', 'pr:acme/web#200')).toContain('cgremlin.chat');
  });

  it('R26 — one Open PR entry per PR, plus Open ticket when there is one', () => {
    const h = build();
    h.ready();
    const row = rowIn(h, 'myWork', 'ticket:HB-627');
    const opens = (row?.actions ?? []).filter((a) => a.command === 'cgremlin.openPr');
    expect(opens.map((a) => a.label)).toEqual(['Open acme/web#310', 'Open acme/api#88']);
    expect((row?.actions ?? []).map((a) => a.command)).toContain('cgremlin.openTicket');
    // The links stay `overflow`-placed: the Item tab still reads the placement, and the panel
    // now renders every placement alike on the open row's action line.
    for (const action of opens) expect(action.placement).toBe('overflow');
  });

  it('finding 1 — the Chat action names the agent it would open', () => {
    const h = build();
    h.ready();
    const chat = (rowIn(h, 'myWork', 'pr:acme/api#77')?.actions ?? []).find(
      (a) => a.command === 'cgremlin.chat',
    );
    // The row carries a triaging respond agent AND a chat-eligible dev agent: the action must
    // name the dev agent, not "whatever the item's first agent happens to be".
    expect(chat?.childId).toBe('agent:dev-acme-api-77');
  });

  it('finding 1 — a row whose only agent is triaging offers no Chat at all', () => {
    const h = build();
    h.ready();
    expect(actionsOf(h, 'waitingForReview', 'pr:acme/web#200')).not.toContain('cgremlin.chat');
  });

  it('P0-2 — Ack only where the item needs you, never unconditionally', () => {
    const h = build();
    h.ready();
    expect(actionsOf(h, 'parkingLot', 'pr:acme/api#55')).not.toContain('cgremlin.ack');
    expect(actionsOf(h, 'parkingLot', 'pr:acme/web#102')).toContain('cgremlin.ack');
  });

  it('P1-5 — every row flags exactly one primary action', () => {
    const h = build();
    h.ready();
    for (const row of h.state().lists.flatMap((l) => l.sections.flatMap((s) => s.rows))) {
      const primaries = row.actions.filter((a) => a.placement === 'primary');
      expect(primaries.length, `${row.list}/${row.id}`).toBeLessThanOrEqual(1);
      if (row.actions.length > 0) expect(primaries.length, `${row.list}/${row.id}`).toBe(1);
    }
  });
});

describe('R35/Phase 8 the banners', () => {
  it('shows the stale banner without emptying myWork', () => {
    const payload = response();
    payload.ticketSource = { kind: 'unavailable', error: 'ETIMEDOUT', scannedAt: null };
    const h = build({ response: payload });
    h.ready();
    expect(h.state().banner?.kind).toBe('stale');
    expect(h.state().lists[1].count).toBeGreaterThan(0);
  });

  it('gives a Jira auth failure the engine-trouble wording, naming the command', () => {
    const payload = response();
    payload.ticketSource = { kind: 'auth', error: '401', scannedAt: null };
    const h = build({ response: payload });
    h.ready();
    expect(h.state().banner?.kind).toBe('auth');
    expect(h.state().banner?.message).toContain('cgremlin-core config check-jira');
  });

  it('replaces the lists entirely while the engine is one we cannot use', () => {
    const h = build();
    h.ready();
    h.panel.setTrouble({ kind: 'foreign', socketPath: '/tmp/engine.sock' });
    expect(h.state().trouble?.message).toContain('not a cgremlin engine this extension can use');
    expect(h.state().trouble?.command).toBe('cgremlin.engine.start');
    expect(h.state().lists).toEqual([]);
    h.panel.setTrouble(null);
    expect(h.state().lists).toHaveLength(4);
  });
});


/**
 * B5 — R66's tree roles and R54's keyboard model, asserted **together**: they come from one pure
 * module, so roles-without-keys and keys-without-roles both fail here.
 */
describe('R66/R54 the panel is an accessible tree, and the keys are the tree model', () => {
  function nodes(h: Built) {
    return panelTreeNodes(h.state());
  }

  it('gives every node a level: 1 for a group header or a row, 2 for a child', () => {
    const h = build();
    h.ready();
    h.view.webview.emit({ type: 'toggleRow', id: 'ticket:HB-627', expanded: true });
    const seen = nodes(h);
    expect(seen.filter((n) => n.kind === 'group').map((n) => n.level)).toEqual([1]);
    expect(seen.filter((n) => n.kind === 'row').every((n) => n.level === 1)).toBe(true);
    // HB-627 is legitimately in two lists (`myWork` and `waitingForReview`), so its three parts
    // are rendered under each of them.
    const children = seen.filter((n) => n.kind === 'child');
    expect(children.length).toBe(6);
    expect(children.every((n) => n.level === 2)).toBe(true);
  });

  it('marks exactly the expandable nodes, and reports their state', () => {
    const h = build();
    h.ready();
    const seen = nodes(h);
    const group = seen.find((n) => n.kind === 'group');
    expect(group).toMatchObject({ expandable: true, expanded: false });
    expect(seen.find((n) => n.id === 'ticket:HB-627')).toMatchObject({
      expandable: true,
      expanded: false,
    });
    // Every row expands now, including a bare parking-lot PR: what it expands into is the three
    // lifecycle slots and "changes so far", which exist whether or not it has a second part.
    expect(seen.find((n) => n.id === 'pr:acme/web#101')).toMatchObject({
      expandable: true,
      expanded: false,
    });
  });

  it('hides a collapsed group’s rows from the sequence but keeps its header focusable', () => {
    const h = build();
    h.ready();
    const seen = nodes(h);
    expect(seen.some((n) => n.id === 'pr:acme/api#55')).toBe(false);
    h.view.webview.emit({
      type: 'toggleGroup',
      list: 'parkingLot',
      group: 'someoneOnIt',
      collapsed: false,
    });
    expect(nodes(h).some((n) => n.id === 'pr:acme/api#55')).toBe(true);
  });

  it('walks the sequence with up and down, and clamps at both ends', () => {
    const h = build();
    h.ready();
    const seen = nodes(h);
    expect(handleKey('ArrowDown', seen, null)).toEqual({ kind: 'focus', key: seen[0].key });
    expect(handleKey('ArrowDown', seen, seen[0].key)).toEqual({ kind: 'focus', key: seen[1].key });
    expect(handleKey('ArrowUp', seen, seen[0].key)).toEqual({ kind: 'focus', key: seen[0].key });
    expect(handleKey('End', seen, seen[0].key)).toEqual({
      kind: 'focus',
      key: seen[seen.length - 1].key,
    });
    expect(handleKey('Home', seen, seen[seen.length - 1].key)).toEqual({
      kind: 'focus',
      key: seen[0].key,
    });
  });

  it('expands with right, collapses with left, and steps out of a child to its row', () => {
    const h = build();
    h.ready();
    const seen = nodes(h);
    const row = seen.find((n) => n.id === 'ticket:HB-627');
    if (row === undefined) throw new Error('no row');
    expect(handleKey('ArrowRight', seen, row.key)).toEqual({
      kind: 'toggleRow',
      id: 'ticket:HB-627',
      expanded: true,
    });

    h.view.webview.emit({ type: 'toggleRow', id: 'ticket:HB-627', expanded: true });
    const opened = nodes(h);
    const openedRow = opened.find((n) => n.id === 'ticket:HB-627');
    if (openedRow === undefined) throw new Error('no row');
    expect(handleKey('ArrowLeft', opened, openedRow.key)).toEqual({
      kind: 'toggleRow',
      id: 'ticket:HB-627',
      expanded: false,
    });
    const child = opened.find((n) => n.kind === 'child');
    if (child === undefined) throw new Error('no child');
    expect(handleKey('ArrowLeft', opened, child.key)).toEqual({
      kind: 'focus',
      key: openedRow.key,
    });
  });

  it('toggles a collapsible group with right and left', () => {
    const h = build();
    h.ready();
    const seen = nodes(h);
    const group = seen.find((n) => n.kind === 'group');
    if (group === undefined) throw new Error('no group');
    expect(handleKey('ArrowRight', seen, group.key)).toEqual({
      kind: 'toggleGroup',
      list: 'parkingLot',
      group: 'someoneOnIt',
      collapsed: false,
    });
  });

  it('activates the focused node with Enter and with Space', () => {
    const h = build();
    h.ready();
    const seen = nodes(h);
    const row = seen.find((n) => n.id === 'pr:acme/web#101');
    if (row === undefined) throw new Error('no row');
    for (const key of ['Enter', ' ']) {
      expect(handleKey(key, seen, row.key)).toEqual({ kind: 'activate', node: row });
    }
    expect(handleKey('x', seen, row.key)).toBeNull();
  });

  it('walks a whole simulated sequence without ever leaving the tree', () => {
    const h = build();
    h.ready();
    let seen = panelTreeNodes(h.state());
    let focus: string | null = null;
    for (const key of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowUp', 'End', 'Home']) {
      const intent = handleKey(key, seen, focus);
      expect(intent?.kind).toBe('focus');
      focus = (intent as { key: string }).key;
      expect(seen.some((node) => node.key === focus)).toBe(true);
      seen = panelTreeNodes(h.state());
    }
  });

  it('declares the roles in the bundled script, not only in the model', () => {
    // The panel is a directory of modules now, and the bundle is all of them: reading only the
    // entry point would let a role quietly leave with the code that set it.
    const dir = path.join(root, 'src/webview/panel');
    const source = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => fs.readFileSync(path.join(dir, name), 'utf8'))
      .join('\n');
    for (const attribute of ['role', 'tree', 'treeitem', 'aria-level', 'aria-expanded', 'aria-selected']) {
      expect(source).toContain(attribute);
    }
    // And the keys come from the same module the roles do (R66).
    expect(source).toContain("from '../../model/panel-tree'");
    expect(source).toContain('handleKey');
  });
});

describe('R54 the look', () => {
  const css = fs.readFileSync(path.join(root, 'media/panel.css'), 'utf8');

  it('takes every colour from a --vscode-* token', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/rgba?\(/);
    expect(css).toContain('var(--vscode-');
  });

  it('loads no icon font, because font-src none would drop it silently', () => {
    expect(css).not.toContain('codicon');
    expect(css).not.toContain('@font-face');
    const script = fs.readFileSync(path.join(root, 'src/webview/panel.ts'), 'utf8');
    expect(script).not.toContain('codicon');
  });

  it('separates card rows with a hairline and dims the second line', () => {
    // §2.3: the divider is the panel border at 40%, so it reads as a rhythm and not as a grid.
    expect(css).toMatch(
      /--cg-divider:\s*color-mix\(in srgb, var\(--vscode-panel-border\) 40%, transparent\)/,
    );
    expect(css).toMatch(/\.row\s*\{[^}]*border-bottom:\s*1px solid var\(--cg-divider\)/);
    expect(css).toMatch(/\.row-meta,\n\.row-state\s*\{[^}]*var\(--vscode-descriptionForeground\)/);
    expect(css).toMatch(/:focus-visible[^}]*outline/);
  });

  it('changes nothing but the background on hover (§2.2 rule 1)', () => {
    const hover = /\.row:hover\s*\{([^}]*)\}/.exec(css);
    expect(hover?.[1].trim()).toBe('background: var(--vscode-list-hoverBackground);');
    // There is no hover-revealed gutter left to fade: a collapsed row carries no control at all.
    expect(css).not.toContain('.row-gutter');
    expect(css).not.toContain('.row-overflow');
    expect(css).not.toMatch(/:hover[^{]*\{[^}]*display:/);
  });

  it('gives every hit target at least 24 px (§2.2 rule 2)', () => {
    for (const selector of ['.row-action', '.slot-start', '.slot-open', '.part-goto']) {
      expect(css).toContain(selector);
    }
    expect(css.match(/min-height:\s*24px/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});

describe('MG-12 the panel half — defaults render as unknown', () => {
  it('renders — for a row whose age and size took their R45 defaults', () => {
    const h = build();
    h.ready();
    const row = h
      .state()
      .lists.flatMap((l) => l.sections.flatMap((s) => s.rows))
      .find((r) => r.id === 'pr:acme/legacy#9');
    expect(row?.age).toBe('—');
    expect(row?.size).toBe('—');
    expect(row?.ci).toBe('');
    const line = row?.meta.map((cell) => cell.text).join(' ') ?? '';
    expect(line).not.toContain('0 files');
    expect(line).toContain('—');
  });
});

describe('R48 the children are clickable, with two actions', () => {
  it('gives each child its Info click and its Go-to label', () => {
    const h = build();
    h.ready();
    h.view.webview.emit({ type: 'toggleRow', id: 'ticket:HB-627', expanded: true });
    const row = h
      .state()
      .lists.flatMap((l) => l.sections.flatMap((s) => s.rows))
      .find((r) => r.id === 'ticket:HB-627');
    expect(row?.children.map((c) => c.goToLabel)).toEqual([
      'Open in Jira',
      'Open on GitHub',
      'Open on GitHub',
    ]);
    h.view.webview.emit({ type: 'openChild', id: 'ticket:HB-627', childId: 'pr:acme/web#310' });
    expect(h.children).toEqual([['ticket:HB-627', 'pr:acme/web#310']]);
  });
});

/**
 * The accents, as a golden list of the theme tokens they are built from.
 *
 * The point is the TOKEN NAMES: a typo in `--vscode-charts-purpel` is a colour that silently
 * resolves to nothing, which is exactly the bug a stylesheet cannot report. So they are written
 * down once here, and the four `--cg-section-*` properties are read back out of the file.
 */
describe('the per-section accents', () => {
  const css = fs.readFileSync(path.join(root, 'media/panel.css'), 'utf8');

  const ACCENTS: Record<string, string> = {
    parkingLot: '--vscode-charts-purple',
    myWork: '--vscode-charts-blue',
    investigations: '--vscode-charts-orange',
    waitingForReview: '--vscode-charts-green',
  };

  it('defines one custom property per list, from the token it is meant to be', () => {
    const found: Record<string, string> = {};
    for (const [, list, token] of css.matchAll(
      /--cg-section-(\w+):\s*var\((--vscode-[\w-]+)\)/g,
    )) {
      found[list] = token;
    }
    expect(found).toEqual(ACCENTS);
  });

  it('spends each one on that list’s header and on its rows’ left edge', () => {
    for (const list of Object.keys(ACCENTS)) {
      expect(css).toContain(`.list-header[data-section='${list}']`);
      expect(css).toContain(`.row.section-${list}`);
      expect(css).toContain(`var(--cg-section-${list})`);
    }
  });

  it('keeps needs-you on a surface of its own, so the two accents never read as one', () => {
    // The section line is the row's BORDER; needs-you is an inset bar drawn inside it, in the one
    // accent the panel has. Different boxes, so a needs-you row in the parking lot says both.
    expect(css).toMatch(/\.row\s*\{[^}]*border-left:\s*2px solid transparent/);
    expect(css).toMatch(/\.row\.needs-you\s*\{[^}]*box-shadow:\s*inset 2px 0 0 var\(--cg-accent\)/);
  });

  it('sets the title a notch above the editor size and the signals below it', () => {
    expect(css).toMatch(/\.row-title\s*\{[^}]*font-size:\s*calc\(var\(--vscode-font-size[^)]*\)[^}]*\}/);
    expect(css).toMatch(/\.row-label\s*\{[^}]*font-weight:\s*600/);
    expect(css).toMatch(/\.row-meta,\n\.row-state\s*\{[^}]*font-size:\s*11px/);
  });
});
