/**
 * The smallest real panel there is: `createUi` over a fake `Host` and a `CoreClient` pointed at
 * the stub server — the same composition `extension.ts` calls, with nothing mocked.
 *
 * Phase 12's two features are both *host* behaviour (a `globalState` override, an optimistic
 * dismissal with a rollback), so their tests need the wiring rather than a hand-built state.
 */
import { expect } from 'vitest';
import { CoreClient } from '../../src/core-client';
import { createUi, type Ui } from '../../src/ui/wiring';
import { FakeHost } from './fake-host';
import { startStubServer, type StubHandler, type StubServerHandle } from './stub-server';
import type { PanelRowView, PanelState } from '../../src/model/panel-protocol';

export interface PanelHarness {
  host: FakeHost;
  ui: Ui;
  server: StubServerHandle;
  state(): PanelState;
  rows(): PanelRowView[];
  rowOf(id: string): PanelRowView | undefined;
  sectionOf(key: string): PanelState['sections'][number] | undefined;
  /** Post a message from the webview to the host, exactly as the real script would. */
  toPanel(message: unknown): void;
  /** Let the coalescing window and the round trips it starts settle. */
  settle(): Promise<void>;
}

const open: { ui: Ui[]; servers: StubServerHandle[] } = { ui: [], servers: [] };

export async function disposeHarnesses(): Promise<void> {
  for (const ui of open.ui.splice(0)) await ui.dispose();
  for (const server of open.servers.splice(0)) await server.dispose();
}

export async function panelHarness(
  options: { handler?: StubHandler; host?: FakeHost } = {},
): Promise<PanelHarness> {
  const server = await startStubServer({ handler: options.handler });
  open.servers.push(server);
  const host = options.host ?? new FakeHost();
  const ui = createUi({
    host,
    client: new CoreClient(server.socketPath),
    notificationLevel: () => 'needs-you-only',
    coalesceMs: 1,
    assets: {
      itemTab: { scriptText: '/* tab */', styleText: '/* tab */' },
      panel: { scriptText: '/* panel */', styleText: '/* panel */' },
      mediaPath: '/ext/media',
    },
  });
  open.ui.push(ui);
  const view = host.resolveView('cgremlin.items');
  view.webview.emit({ type: 'ready' });
  expect(await ui.connect()).toBe(true);

  const state = (): PanelState => {
    const render = [...view.webview.posted]
      .reverse()
      .find((message) => (message as { type?: string }).type === 'render') as
      | { state: PanelState }
      | undefined;
    if (render === undefined) throw new Error('the panel rendered nothing');
    return render.state;
  };
  const rows = (): PanelRowView[] => state().sections.flatMap((section) => section.rows);
  return {
    host,
    ui,
    server,
    state,
    rows,
    rowOf: (id) => rows().find((row) => row.id === id),
    sectionOf: (key) => state().sections.find((section) => section.key === key),
    toPanel: (message) => view.webview.emit(message),
    settle: async () => {
      host.flushTimeouts();
      await ui.settled();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await ui.settled();
    },
  };
}
