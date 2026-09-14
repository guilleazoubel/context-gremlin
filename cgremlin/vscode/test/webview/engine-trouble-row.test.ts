/**
 * The trouble row, after the incident that left the engine dead.
 *
 * The panel used to explain a failure and offer exactly one button — "Show log" — which tells the
 * user what went wrong and leaves them with no way to fix it. With no engine, the panel must
 * offer ONE click that brings it back, with the log beside it rather than instead of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDom, type FakeElement, type InstalledDom } from '../support/fake-dom';
import { stateOf } from './state';
import type { PanelState } from '../../src/model/panel-protocol';

interface Panel {
  render(next: PanelState): void;
}

let dom: InstalledDom;
let panel: Panel;

beforeEach(async () => {
  vi.resetModules();
  dom = installDom();
  panel = (await import('../../src/webview/panel')) as unknown as Panel;
});

afterEach(() => {
  dom.uninstall();
});

const NOT_RUNNING: PanelState = {
  ...stateOf(),
  sections: [],
  trouble: {
    message: 'The cgremlin engine is not running.',
    command: 'cgremlin.engine.start',
    actionLabel: 'Start the engine',
    secondary: { command: 'cgremlin.engine.showLog', actionLabel: 'Show log' },
  },
};

const row = (): FakeElement | undefined => dom.root.byClass('trouble')[0];

describe('the engine-trouble row', () => {
  it('offers the start first and the log beside it', () => {
    panel.render(NOT_RUNNING);
    expect(row()?.byClass('trouble-action')[0]?.textContent).toBe('Start the engine');
    expect(row()?.byClass('trouble-second')[0]?.textContent).toBe('Show log');
  });

  it('starts the engine on the primary click, and shows the log on the second', () => {
    panel.render(NOT_RUNNING);
    dom.posted.length = 0;
    row()?.byClass('trouble-action')[0]?.emit('click');
    row()?.byClass('trouble-second')[0]?.emit('click');
    expect(dom.posted).toEqual([
      { type: 'command', command: 'cgremlin.engine.start', id: 'engine' },
      { type: 'command', command: 'cgremlin.engine.showLog', id: 'engine' },
    ]);
  });

  it('hides the second button when the trouble has only one thing to offer', () => {
    panel.render({
      ...NOT_RUNNING,
      trouble: {
        message: 'This window runs an older cgremlin extension than the engine.',
        command: 'workbench.action.reloadWindow',
        actionLabel: 'Reload window',
        secondary: null,
      },
    });
    expect(row()?.byClass('trouble-second')[0]?.hidden).toBe(true);
  });
});
