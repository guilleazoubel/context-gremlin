/**
 * §4 (amended) — one click on a row is ONE decision with three consequences: it becomes the
 * selected row, it expands (accordion), and the workspace swaps to that item's worktree.
 *
 * The failure this pins down is the partial one: a click that selects but does not swap, or that
 * swaps twice, leaves the highlight and the open editors disagreeing about which work the user is
 * on — which is worse than not swapping at all.
 */
import { describe, expect, it } from 'vitest';
import {
  EXPANDED_STATE_KEY,
  PanelView,
  SELECTED_STATE_KEY,
  type ExpandedDetail,
} from '../../src/ui/panel-view';
import { FakeHost, FakeWebviewView } from '../support/fake-host';
import itemsFixture from '../support/fixtures/items.json';
import type { ItemsResponse } from '../../src/model/work-items';
import type { PanelRowView, PanelState } from '../../src/model/panel-protocol';

const NOW = Date.parse('2026-09-10T12:00:00.000Z');

function response(): ItemsResponse {
  return JSON.parse(JSON.stringify(itemsFixture)) as ItemsResponse;
}

interface Built {
  host: FakeHost;
  panel: PanelView;
  view: FakeWebviewView;
  selected: string[];
  loaded: string[];
  state(): PanelState;
  row(id: string): PanelRowView | undefined;
  renders(): number;
}

function build(
  over: { host?: FakeHost; detail?: ExpandedDetail | null } = {},
): Built {
  const host = over.host ?? new FakeHost();
  const selected: string[] = [];
  const loaded: string[] = [];
  const panel = new PanelView({
    host,
    assets: { scriptText: '', styleText: '' },
    mediaPath: '/ext/media',
    onOpenItem: () => {},
    onOpenChild: () => {},
    onCommand: () => {},
    onSelect: (id) => {
      selected.push(id);
    },
    loadExpanded: async (item) => {
      loaded.push(item.id);
      return over.detail === undefined ? null : over.detail;
    },
    now: () => NOW,
    nonce: () => 'test-nonce',
  });
  const view = new FakeWebviewView();
  panel.resolveWebviewView(view);
  panel.setItems(response());
  panel.setConnected(true);
  view.webview.emit({ type: 'ready' });
  const state = (): PanelState => {
    const render = [...view.webview.posted]
      .reverse()
      .find((m) => (m as { type?: string }).type === 'render') as { state: PanelState } | undefined;
    if (render === undefined) throw new Error('nothing rendered');
    return render.state;
  };
  return {
    host,
    panel,
    view,
    selected,
    loaded,
    state,
    row: (id) =>
      state()
        .lists.flatMap((list) => list.sections.flatMap((section) => section.rows))
        .find((row) => row.id === id),
    renders: () =>
      view.webview.posted.filter((m) => (m as { type?: string }).type === 'render').length,
  };
}

/** Let the detail promise and its `finally` run, so the next refresh is not merely in-flight. */
const settle = async (): Promise<void> => {
  for (let at = 0; at < 4; at += 1) await Promise.resolve();
};

const click = (h: Built, id: string): void =>
  h.view.webview.emit({ type: 'selectRow', id, list: 'myWork' });

describe('one click selects, expands and swaps — once', () => {
  it('does all three from a single message', () => {
    const h = build();
    click(h, 'ticket:HB-627');
    expect(h.row('ticket:HB-627')).toMatchObject({ selected: true, expanded: true });
    expect(h.selected).toEqual(['ticket:HB-627']);
  });

  it('opens one row at a time — the accordion has no second drawer', () => {
    const h = build();
    click(h, 'ticket:HB-627');
    click(h, 'pr:acme/web#200');
    expect(h.row('ticket:HB-627')).toMatchObject({ selected: false, expanded: false });
    expect(h.row('pr:acme/web#200')).toMatchObject({ selected: true, expanded: true });
    expect(h.selected).toEqual(['ticket:HB-627', 'pr:acme/web#200']);
  });

  it('closes the row that is already open, and leaves the selection where the user put it', () => {
    const h = build();
    click(h, 'ticket:HB-627');
    click(h, 'ticket:HB-627');
    expect(h.row('ticket:HB-627')).toMatchObject({ selected: true, expanded: false });
  });

  it('remembers both across a reload, so the panel comes back where it was left', () => {
    const first = build();
    click(first, 'ticket:HB-627');
    expect(first.host.getState(SELECTED_STATE_KEY)).toBe('ticket:HB-627');
    expect(first.host.getState(EXPANDED_STATE_KEY)).toBe('ticket:HB-627');

    const again = build({ host: first.host });
    expect(again.row('ticket:HB-627')).toMatchObject({ selected: true, expanded: true });
  });

  it('never changes a row’s height on a refresh — only a click does that', () => {
    const h = build();
    click(h, 'ticket:HB-627');
    h.panel.setItems(response());
    expect(h.row('ticket:HB-627')?.expanded).toBe(true);
    expect(h.row('pr:acme/web#200')?.expanded).toBe(false);
  });
});

describe('what an expanded row asks the engine for', () => {
  it('paints `—` until the engine has answered, and never a fabricated zero', () => {
    const h = build({ detail: null });
    click(h, 'ticket:HB-627');
    expect(h.row('ticket:HB-627')?.changes).toEqual({ committed: '—', workingTree: '—' });
  });

  it('reads the change counts and the artifact times once they arrive', async () => {
    const h = build({
      detail: {
        artifactAt: { 'inv-hb-627': '2026-09-10T10:00:00.000Z' },
        changes: {
          base: 'main',
          baseResolved: true,
          head: 'e4f5a6b',
          committed: { files: 8, additions: 240, deletions: 31 },
          workingTree: { files: 2, additions: 12, deletions: 0 },
        },
      },
    });
    click(h, 'ticket:HB-627');
    await Promise.resolve();
    await Promise.resolve();
    expect(h.row('ticket:HB-627')?.changes).toEqual({
      committed: '8 files +240/−31',
      workingTree: '2 files +12/−0',
    });
    expect(h.loaded).toEqual(['ticket:HB-627']);
  });

  it('reads the detail when the keyboard opens a row, not only when a click does', async () => {
    const h = build();
    h.view.webview.emit({ type: 'toggleRow', id: 'ticket:HB-627', expanded: true });
    await settle();
    expect(h.loaded).toEqual(['ticket:HB-627']);
  });

  it('asks for nothing at all while every row is shut', () => {
    const h = build();
    h.panel.setItems(response());
    expect(h.loaded).toEqual([]);
  });

  it('asks once for an expansion, and not again for twenty unrelated refreshes', async () => {
    const h = build();
    click(h, 'ticket:HB-627');
    await settle();
    expect(h.loaded).toEqual(['ticket:HB-627']);
    // Every SSE frame schedules a refresh. A burst about other work must not re-read this row's
    // artifacts and its `/changes` twenty more times.
    for (let at = 0; at < 20; at += 1) {
      h.panel.setItems(response());
      await settle();
    }
    expect(h.loaded).toEqual(['ticket:HB-627']);
  });

  it('asks again when the open row’s own state moves on', async () => {
    const h = build();
    click(h, 'ticket:HB-627');
    await settle();
    const changed = response();
    const item = changed.items.find((candidate) => candidate.id === 'ticket:HB-627');
    if (item === undefined) throw new Error('fixture');
    item.agents[1].phase = 'reviewing';
    h.panel.setItems(changed);
    await settle();
    expect(h.loaded).toEqual(['ticket:HB-627', 'ticket:HB-627']);
  });

  it('asks again for an artifact frame that names one of the open row’s sessions', async () => {
    const h = build();
    click(h, 'ticket:HB-627');
    await settle();
    const sessionId = response().items.find((i) => i.id === 'ticket:HB-627')?.agents[0].sessionId;
    if (sessionId === undefined) throw new Error('fixture');

    // An artifact was rewritten without any field of the item changing — the one case a snapshot
    // comparison cannot see, and exactly what dates a slot's `done`.
    h.panel.noteFrame(null, sessionId);
    h.panel.setItems(response());
    await settle();
    expect(h.loaded).toEqual(['ticket:HB-627', 'ticket:HB-627']);
  });

  it('ignores a frame about work the open row has nothing to do with', async () => {
    const h = build();
    click(h, 'ticket:HB-627');
    await settle();
    h.panel.noteFrame('pr:acme/web#101', null);
    h.panel.noteFrame(null, 'some-other-session');
    h.panel.setItems(response());
    await settle();
    expect(h.loaded).toEqual(['ticket:HB-627']);
  });

  it('offers, in the slots, exactly the Start the row’s own rule allows (§4)', () => {
    const h = build();
    click(h, 'ticket:HB-627');
    const slots = h.row('ticket:HB-627')?.lifecycle ?? [];
    expect(slots.map((slot) => slot.start?.command ?? null)).toEqual([
      null,
      null,
      'cgremlin.startReview',
    ]);
    // HB-627's PRs are the user's own, so the review the core would accept is a self-review.
    expect(slots[2].start?.label).toBe('Start self-review');
  });
});

describe('§3.3 one refresh is one render', () => {
  it('posts once for the three setters a refresh calls', () => {
    const h = build();
    const before = h.renders();
    const changed = response();
    const item = changed.items.find((candidate) => candidate.id === 'ticket:HB-627');
    if (item?.ticket == null) throw new Error('fixture');
    item.ticket.status = 'In Review';
    h.panel.batch(() => {
      h.panel.setSourceTrouble(null);
      h.panel.setConnected(true);
      h.panel.setItems(changed);
    });
    expect(h.renders() - before).toBe(1);
  });

  it('posts nothing at all for a refresh that changed nothing', () => {
    const h = build();
    const before = h.renders();
    h.panel.batch(() => {
      h.panel.setConnected(true);
      h.panel.setItems(response());
    });
    expect(h.renders()).toBe(before);
  });
});
