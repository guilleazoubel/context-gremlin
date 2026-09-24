/**
 * The REAL bundle, driven with the user's REAL answer, through the panel's own message path.
 *
 * Every other webview test imports `src/webview/panel` as TypeScript and calls `render` directly,
 * and every other panel test builds its state from a hand-made fixture. So two things were never
 * executed by a test at all: the artefact the extension actually ships (`media/panel.js`, built by
 * esbuild and inlined into the webview's HTML), and a `PanelState` built by `PanelView` out of a
 * real `GET /items`. A blank panel lives exactly in that gap — an exception at render time inside
 * the bundle, or a shape the state builder chokes on — which is how 1013 green tests sat beside a
 * sidebar showing nothing.
 *
 * This closes it end to end: the fixture is a trimmed copy of the answer the user's engine gave
 * (all six lists, an item with `qaDeploy`, a ticket with no PRs, an item no list names), the host
 * builds the state, esbuild builds the bundle with the shipped flags, and the state crosses the
 * `window` message channel exactly as the editor delivers it. Any throw on the way is the test
 * failing, loudly, instead of a panel that quietly renders nothing.
 */
import vm from 'node:vm';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { beforeAll, afterEach, describe, expect, it } from 'vitest';
import { PanelView } from '../../src/ui/panel-view';
import { FakeHost, FakeWebviewView } from '../support/fake-host';
import { installDom, type InstalledDom } from '../support/fake-dom';
import payload from '../support/fixtures/panel-blank-items.json';
import type { ItemsResponse } from '../../src/model/work-items';
import type { PanelState } from '../../src/model/panel-protocol';

const ROOT = path.resolve(__dirname, '../..');
let bundle: string;

/** The same entry point and the same flags as `package.json`'s `build:webview`. */
beforeAll(() => {
  const built = buildSync({
    entryPoints: [path.join(ROOT, 'src/webview/panel.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    write: false,
  });
  bundle = built.outputFiles[0].text;
});

/** What `PanelView` posts for that answer — the host half of the path, with nothing stubbed. */
function hostState(): PanelState {
  const panel = new PanelView({
    host: new FakeHost(),
    assets: { scriptText: '/* panel */', styleText: '/* panel */' },
    mediaPath: '/ext/media',
    onOpenItem: () => {},
    onOpenChild: () => {},
    onCommand: () => {},
    now: () => Date.parse('2026-09-16T21:10:00.000Z'),
    nonce: () => 'test-nonce',
  });
  const view = new FakeWebviewView();
  panel.resolveWebviewView(view);
  panel.setItems(JSON.parse(JSON.stringify(payload)) as ItemsResponse);
  panel.setConnected(true);
  view.webview.emit({ type: 'ready' });
  const render = [...view.webview.posted]
    .reverse()
    .find((message) => (message as { type?: string }).type === 'render') as
    | { state: PanelState }
    | undefined;
  if (render === undefined) throw new Error('the host posted no render at all');
  return render.state;
}

let dom: InstalledDom;

afterEach(() => {
  dom.uninstall();
});

/** Loads the bundle over an installed DOM, then delivers one host message to it. */
function run(state: PanelState): InstalledDom {
  dom = installDom();
  vm.runInThisContext(bundle, { filename: 'media/panel.js' });
  dom.send({ type: 'render', state });
  return dom;
}

describe('media/panel.js, over the answer a real engine gave', () => {
  it('draws a row for every item the lists name', () => {
    const state = hostState();
    const expected = state.sections
      .filter((section) => !section.collapsed)
      .reduce((sum, section) => sum + section.rows.length, 0);
    expect(expected).toBeGreaterThan(0);

    const painted = run(state);

    expect(painted.posted).toContainEqual({ type: 'ready' });
    expect(painted.root.byClass('row')).toHaveLength(expected);
    // Not merely present: the identity line every row is read by has to carry its keys.
    const first = painted.root.byClass('row')[0];
    expect(first.querySelector('.id-keys')?.textContent).not.toBe('');
  });

  it('draws the seven sections, and re-renders the same answer without mutating anything', () => {
    const state = hostState();
    const painted = run(state);
    expect(painted.root.byClass('section')).toHaveLength(7);

    painted.document.clearLog();
    painted.send({ type: 'render', state });
    expect(painted.document.log).toEqual([]);
  });

  /**
   * The harness's own contract, and the reason this file exists: an exception thrown INSIDE the
   * render has to reach the test. A DOM stand-in that swallowed it would turn every future blank
   * panel back into a green suite.
   */
  it('fails loudly when the render throws, instead of leaving the panel empty', () => {
    dom = installDom();
    vm.runInThisContext(bundle, { filename: 'media/panel.js' });
    expect(() => dom.send({ type: 'render', state: { sections: null } })).toThrow();
    expect(dom.root.byClass('row')).toHaveLength(0);
  });
});
