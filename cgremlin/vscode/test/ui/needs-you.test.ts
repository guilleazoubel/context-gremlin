/**
 * P3 — "the popup bothers".
 *
 * Needs-you used to arrive as a VS Code toast, over whatever the user was typing into, once per
 * item per change. The news is worth having; the modal-ish interruption is not. So by default it
 * arrives where the user can look at it when they choose: a strip at the top of the panel, a
 * badge on the view container, and the count the status bar already carried. P10 finished the
 * job: there is no level that raises one any more, and `all` is read as the default.
 */
import { describe, expect, it } from 'vitest';
import { PanelView } from '../../src/ui/panel-view';
import { NotificationSurface } from '../../src/ui/notifications';
import { FakeHost, FakeWebviewView } from '../support/fake-host';
import itemsFixture from '../support/fixtures/items.json';
import { normalizeLevel } from '../../src/model/notify-policy';
import type { ItemsResponse, WorkItem } from '../../src/model/work-items';
import type { PanelState } from '../../src/model/panel-protocol';

function response(): ItemsResponse {
  return JSON.parse(JSON.stringify(itemsFixture)) as ItemsResponse;
}

function build(): { host: FakeHost; view: FakeWebviewView; state: () => PanelState } {
  const host = new FakeHost();
  const panel = new PanelView({
    host,
    assets: { scriptText: '1;', styleText: '' },
    mediaPath: '/ext/media',
    onOpenItem: () => {},
    onOpenChild: () => {},
    onCommand: () => {},
    now: () => Date.parse('2026-09-10T12:00:00.000Z'),
    nonce: () => 'test-nonce',
  });
  const view = new FakeWebviewView();
  panel.resolveWebviewView(view);
  view.webview.emit({ type: 'ready' });
  panel.setItems(response());
  panel.setConnected(true);
  return { host, view, state: () => panel.state() };
}

const NEEDS_YOU = ['pr:acme/web#102', 'pr:acme/web#200', 'ticket:HB-627'];

describe('P3 the needs-you strip', () => {
  it('lists exactly the items the core flagged, with the reason it gave', () => {
    const { state } = build();
    expect(state().needsYou.map((entry) => entry.id)).toEqual(NEEDS_YOU);
    const first = state().needsYou[0];
    expect(first.label).toContain('acme/web#102');
    expect(first.reason).toBe('review ready');
    // Every entry can be clicked back to a row, so it carries the list that row is in.
    expect(state().needsYou.map((entry) => entry.list)).toEqual([
      'parkingLot',
      'myWork',
      'myWork',
    ]);
  });

  it('empties the moment the core stops flagging anything', () => {
    const host = new FakeHost();
    const panel = new PanelView({
      host,
      assets: { scriptText: '1;', styleText: '' },
      mediaPath: '/ext/media',
      onOpenItem: () => {},
      onOpenChild: () => {},
      onCommand: () => {},
      nonce: () => 'test-nonce',
    });
    const view = new FakeWebviewView();
    panel.resolveWebviewView(view);
    view.webview.emit({ type: 'ready' });
    panel.setItems(response());
    expect(panel.state().needsYou.length).toBe(3);

    const quiet = response();
    for (const item of quiet.items) item.needsYou = false;
    panel.setItems(quiet);
    expect(panel.state().needsYou).toEqual([]);
    expect(view.badge).toBeUndefined();
  });
});

describe('P3 the view-container badge', () => {
  it('carries the needs-you count and says what it counts', () => {
    const { view } = build();
    expect(view.badge).toEqual({ value: 3, tooltip: '3 items need you' });
  });

  it('is removed rather than set to zero when nothing wants the user', () => {
    const host = new FakeHost();
    const panel = new PanelView({
      host,
      assets: { scriptText: '1;', styleText: '' },
      mediaPath: '/ext/media',
      onOpenItem: () => {},
      onOpenChild: () => {},
      onCommand: () => {},
      nonce: () => 'test-nonce',
    });
    const view = new FakeWebviewView();
    panel.resolveWebviewView(view);
    view.webview.emit({ type: 'ready' });
    const quiet = response();
    for (const item of quiet.items) item.needsYou = false;
    panel.setItems(quiet);
    expect(view.badge).toBeUndefined();
  });

  it('says "1 item needs you" for one', () => {
    const host = new FakeHost();
    const panel = new PanelView({
      host,
      assets: { scriptText: '1;', styleText: '' },
      mediaPath: '/ext/media',
      onOpenItem: () => {},
      onOpenChild: () => {},
      onCommand: () => {},
      nonce: () => 'test-nonce',
    });
    const view = new FakeWebviewView();
    panel.resolveWebviewView(view);
    view.webview.emit({ type: 'ready' });
    const one = response();
    for (const item of one.items) item.needsYou = item.id === 'ticket:HB-627';
    panel.setItems(one);
    expect(view.badge).toEqual({ value: 1, tooltip: '1 item needs you' });
  });
});

describe('P10 needs-you never toasts', () => {
  const entering = (): [WorkItem[], WorkItem[]] => {
    const before = response().items.map((item) => ({ ...item, needsYou: false }));
    return [before, response().items];
  };

  for (const level of ['needs-you-only', 'off'] as const) {
    it(`raises nothing at ${level} for items entering needs-you`, async () => {
      const host = new FakeHost();
      const surface = new NotificationSurface(host);
      const [before, after] = entering();
      surface.apply(before, after, level);
      await surface.settled();
      expect(host.kinds().filter((kind) => kind.startsWith('show'))).toEqual([]);
    });
  }

  it('raises nothing for the legacy `all`, which now reads as the default', async () => {
    const host = new FakeHost();
    const surface = new NotificationSurface(host);
    const [before, after] = entering();
    surface.apply(before, after, normalizeLevel('all'));
    await surface.settled();
    expect(normalizeLevel('all')).toBe('needs-you-only');
    expect(host.kinds().filter((kind) => kind.startsWith('show'))).toEqual([]);
  });

  it('leaves the engine-not-running warning to the panel and the status bar at every level', async () => {
    for (const level of ['needs-you-only', 'off', normalizeLevel('all')] as const) {
      const host = new FakeHost();
      const surface = new NotificationSurface(host);
      surface.reportOffline(level);
      await surface.settled();
      expect(host.kinds().filter((kind) => kind.startsWith('show'))).toEqual([]);
    }
  });

  it('still says a failed command out loud, because that answers a click the user just made', async () => {
    const host = new FakeHost();
    const surface = new NotificationSurface(host);
    surface.warn('the engine refused that');
    await surface.settled();
    expect(host.callsOf('showWarningMessage')[0].args[0]).toBe('the engine refused that');
  });
});
