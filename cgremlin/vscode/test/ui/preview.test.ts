/**
 * The worktree swap, against a fake editor host.
 *
 * The rule with teeth here: two clicks close together must never both mutate the workspace.
 * §5.5 keeps exactly one repo folder in the managed workspace, and a swap whose dirty-editor
 * confirm is still pending when a second click arrives must not land its (by then stale) plan
 * once that confirm resolves — the last click is the one that wins.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { SWITCH_ANYWAY, WorktreeSwapper, managedWorkspacePath } from '../../src/ui/preview';
import type { CoreConfigView } from '../../src/model/items';
import { FakeHost } from '../support/fake-host';

const STATE_DIR = '/home/me/.cgremlin-core';
const MANAGED_PATH = managedWorkspacePath(STATE_DIR);

function config(): CoreConfigView {
  return {
    repos: [],
    watchAuthors: [],
    me: 'someone',
    runner: 'claude-code',
    pollIntervalMs: 1000,
    stateDir: STATE_DIR,
    sessionsDir: `${STATE_DIR}/sessions`,
    worktreesDir: `${STATE_DIR}/worktrees`,
    mirrorsDir: `${STATE_DIR}/mirrors`,
    socketPath: `${STATE_DIR}/engine.sock`,
    inventoryPath: `${STATE_DIR}/inventory.json`,
    defaultBaseRef: 'origin/main',
  };
}

let host: FakeHost;
let swapper: WorktreeSwapper;

beforeEach(() => {
  host = new FakeHost();
  host.workspaceFilePath = MANAGED_PATH;
  // One folder already open, with a dirty editor inside it — every swap below requires a confirm.
  host.folders = ['/wt/old'];
  host.dirty = ['/wt/old/file.ts'];
  swapper = new WorktreeSwapper({ host, config });
});

describe('two clicks before the first confirm resolves', () => {
  it('lands exactly one updateWorkspaceFolders, for the second click', async () => {
    host.messageAnswers = [SWITCH_ANYWAY, SWITCH_ANYWAY];
    const a = swapper.swapTo('a', '/wt/a');
    const b = swapper.swapTo('b', '/wt/b');
    await Promise.all([a, b]);

    const swaps = host.callsOf('updateWorkspaceFolders');
    expect(swaps).toHaveLength(1);
    expect(swaps[0].args[2]).toEqual([{ uri: '/wt/b', name: 'b' }]);
  });

  it('never shows more than one confirm dialog for the pair', async () => {
    host.messageAnswers = [SWITCH_ANYWAY, SWITCH_ANYWAY];
    const a = swapper.swapTo('a', '/wt/a');
    const b = swapper.swapTo('b', '/wt/b');
    await Promise.all([a, b]);

    expect(host.callsOf('showWarningMessage')).toHaveLength(1);
  });

  it('a third click still wins over the first two', async () => {
    host.messageAnswers = [SWITCH_ANYWAY, SWITCH_ANYWAY, SWITCH_ANYWAY];
    const a = swapper.swapTo('a', '/wt/a');
    const b = swapper.swapTo('b', '/wt/b');
    const c = swapper.swapTo('c', '/wt/c');
    await Promise.all([a, b, c]);

    const swaps = host.callsOf('updateWorkspaceFolders');
    expect(swaps).toHaveLength(1);
    expect(swaps[0].args[2]).toEqual([{ uri: '/wt/c', name: 'c' }]);
  });
});

describe('one click at a time', () => {
  it('still swaps normally', async () => {
    host.messageAnswers = [SWITCH_ANYWAY];
    await swapper.swapTo('a', '/wt/a');
    expect(host.callsOf('updateWorkspaceFolders')).toHaveLength(1);

    host.folders = ['/wt/a'];
    host.dirty = [];
    host.messageAnswers = [];
    await swapper.swapTo('a', '/wt/a');
    // Already the only folder: a no-op, not a second swap.
    expect(host.callsOf('updateWorkspaceFolders')).toHaveLength(1);
  });
});
