/**
 * Defect 4 — the pane, on the rendered DOM.
 *
 * The user started a plan stage, clicked Chat, and was told `already has a stage run in progress`.
 * The refusal is right — two writers on one transcript is corruption — but "you may not interrupt
 * this" and "you may not SEE this" are different rules, and one check was answering both. Reading
 * is safe, so there is a pane.
 *
 * What it must never do is imply it is the record. It shows what it saw, says what it missed, and
 * freezes when the run stops; the artifact on disk is the record (the R41 exception in
 * `ui/wiring.ts` says why it can be nothing else).
 */
import { describe, expect, it } from 'vitest';
// Import order matters: this installs the DOM globals the webview module reaches for at load.
import { dom } from '../support/install-item-tab-dom';
import * as webview from '../../src/webview/item-tab';
import { partsOf } from '../../src/model/item-tab-parts';
import { RunOutputStore } from '../../src/model/run-output';
import type { ItemTabState, TabAgent } from '../../src/model/item-tab-protocol';

const SESSION = 'inv-aplaceformom-grace-frontend-HB-1492-20260922-135058';

function agentWith(store: RunOutputStore): TabAgent {
  return {
    sessionId: SESSION,
    mode: 'investigation',
    phase: 'plan',
    running: true,
    needsYou: false,
    claimed: false,
    glyph: '',
    primaryArtifact: null,
    artifacts: [],
    runOutput: store.viewOf(SESSION),
  } as TabAgent;
}

function render(store: RunOutputStore): void {
  const agent = agentWith(store);
  const built = {
    itemId: `session:${SESSION}`,
    title: SESSION,
    needsYou: false,
    chips: [],
    buttons: [],
    agents: [agent],
    selectedSessionId: SESSION,
    prs: [],
    ticket: null,
    ticketError: null,
    lists: [],
    parts: [],
    focus: { kind: 'runOutput', sessionId: SESSION },
  } as unknown as ItemTabState;
  built.parts = partsOf(built);
  webview.render(built);
}

const byClass = (name: string) => dom.document.body.byClass(name)[0];
const lines = (): string[] =>
  (byClass('run-output-lines')?.children ?? []).map((node) => node.textContent);

function opened(alreadyRunning: boolean, live = true): RunOutputStore {
  const store = new RunOutputStore();
  store.open(SESSION, { alreadyRunning, stage: 'plan', live });
  return store;
}

describe('the output pane is a part of the item tab', () => {
  it('is listed beside the artifacts, so the tablist can reach it', () => {
    const store = opened(false);
    const built = { agents: [agentWith(store)], selectedSessionId: SESSION, prs: [], ticket: null, ticketError: null } as unknown as ItemTabState;
    const parts = partsOf(built);
    expect(parts.map((part) => part.label)).toContain('Output');
    expect(parts.find((part) => part.label === 'Output')?.focus).toEqual({
      kind: 'runOutput',
      sessionId: SESSION,
    });
  });

  it('is absent when nothing has ever opened a buffer for this agent', () => {
    const bare = { agents: [{ ...agentWith(new RunOutputStore()), runOutput: null }], selectedSessionId: SESSION, prs: [], ticket: null, ticketError: null } as unknown as ItemTabState;
    expect(partsOf(bare).map((part) => part.label)).not.toContain('Output');
  });
});

describe('what the pane shows', () => {
  it('a live run with nothing yet says so, rather than sitting empty', () => {
    render(opened(false));
    expect(lines()).toEqual([]);
    expect(byClass('run-output-notice').textContent).toContain('has not done anything yet');
    expect(byClass('run-output-notice').hidden).toBe(false);
  });

  it('a live run with output shows its lines, newest last, with the notice out of the way', () => {
    const store = opened(false);
    store.append(SESSION, 'Reading the ticket…\nPlanning the change\n');
    render(store);
    expect(lines()).toEqual(['Reading the ticket…', 'Planning the change']);
    expect(byClass('run-output-notice').hidden).toBe(true);
  });

  it('a mid-run join says the beginning was never kept, above the lines it does have', () => {
    const store = opened(true);
    store.append(SESSION, 'a later line\n');
    render(store);
    expect(byClass('run-output-notice').textContent).toContain('joined this run in progress');
    expect(lines()).toEqual(['a later line']);
  });

  it('freezes on its ending line when the run stops, and keeps the lines readable', () => {
    const store = opened(false);
    store.append(SESSION, 'done\n');
    store.finish(SESSION, { outcome: 'succeeded' });
    render(store);
    expect(byClass('run-output-ending').hidden).toBe(false);
    expect(byClass('run-output-ending').textContent).toContain('artifact');
    expect(lines()).toEqual(['done']);
  });

  it('says nothing is running when the pane is opened on an idle session', () => {
    render(opened(false, false));
    expect(byClass('run-output-notice').textContent).toContain('Nothing is running');
    expect(byClass('run-output-ending').hidden).toBe(true);
  });
});

describe('the pane is cheap to keep open', () => {
  it('appends without rewriting the lines it already drew (keyed by line number)', () => {
    const store = opened(false);
    store.append(SESSION, 'one\n');
    render(store);
    const first = byClass('run-output-lines').children[0];
    store.append(SESSION, 'two\n');
    render(store);
    expect(byClass('run-output-lines').children[0]).toBe(first);
    expect(lines()).toEqual(['one', 'two']);
  });

  it('performs no write at all when the same view is rendered twice', () => {
    const store = opened(false);
    store.append(SESSION, 'one\n');
    render(store);
    dom.document.writes.length = 0;
    render(store);
    expect(dom.document.writes).toEqual([]);
  });
});
