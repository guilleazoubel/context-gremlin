/**
 * Task 1, the surface the user was actually reading: the Item tab's title.
 *
 * `HB-1490 — Fetch Care Guide…` is the engine's own `WorkItem.title`, and no pull request number
 * has ever been in it. The row beside it says `HB-1490 #2037`, so the two names for one piece of
 * work disagreed — which is exactly the report ("it doesnt show the pr on the title either").
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CoreClient } from '../../src/core-client';
import { ItemTab } from '../../src/ui/item-tab';
import { WorktreeSwapper } from '../../src/ui/preview';
import { FakeHost } from '../support/fake-host';
import { startStubServer, type StubServerHandle } from '../support/stub-server';
import { hb1490 } from '../support/hb-1490';
import type { ItemTabState } from '../../src/model/item-tab-protocol';

const servers: StubServerHandle[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.dispose();
});

async function open(): Promise<{ host: FakeHost; state: ItemTabState }> {
  const item = hb1490();
  const server = await startStubServer({
    handler: (req) => {
      if (req.method === 'GET' && req.path === '/items/ticket/HB-1490') {
        return {
          status: 200,
          body: {
            item,
            ticket: null,
            ticketError: null,
            artifacts: { [item.agents[0].sessionId]: [] },
          },
        };
      }
      return undefined;
    },
  });
  servers.push(server);
  const host = new FakeHost();
  host.workspaceFilePath = '/tmp/cgremlin-fixture/cgremlin.code-workspace';
  const config = () =>
    ({ stateDir: '/tmp/cgremlin-fixture', sessionsDir: '/tmp/cgremlin-fixture/sessions' }) as never;
  const tab = new ItemTab({
    host,
    client: new CoreClient(server.socketPath),
    config,
    assets: { scriptText: 'void 0;', styleText: 'body{}' },
    mediaPath: '/ext/media',
    swapper: new WorktreeSwapper({ host, config }),
    onOpened: () => undefined,
    nonce: () => 'nonce-1',
  });
  await tab.open('ticket/HB-1490');
  for (const panel of host.panels) panel.webview.emit({ type: 'ready' });
  await tab.settled();
  const panel = host.panels[host.panels.length - 1];
  const render = [...panel.webview.posted]
    .reverse()
    .find((m) => (m as { type?: string }).type === 'render') as
    | { type: 'render'; state: ItemTabState }
    | undefined;
  if (render === undefined) throw new Error('nothing rendered');
  return { host, state: render.state };
}

describe('the Item tab is named the same thing the row is', () => {
  it('names the tab with the ticket key and the pull request number', async () => {
    const { host } = await open();
    expect(host.panels[0].title).toContain('HB-1490');
    expect(host.panels[0].title).toContain('#2037');
  });

  it('renders the same headline into the tab body', async () => {
    const { state } = await open();
    expect(state.title).toContain('HB-1490');
    expect(state.title).toContain('#2037');
  });
});
