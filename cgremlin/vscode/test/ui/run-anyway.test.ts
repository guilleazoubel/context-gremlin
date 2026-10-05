/**
 * 0c Task 6 — the Item tab says why a headless run was not started, and for a Jira ticket it
 * could not load it offers ONE way through: "Run anyway", which re-issues the same stage with
 * `skipJiraCheck: true`. GitHub is never skippable, so a `GitHub …` block has the reason and no
 * button.
 *
 * And the other half (carry-over 1): a start the preflight blocked answers 200 `started:false`,
 * which the start verbs used to read as success — the row said `running` for a run that never
 * began.
 */
import { afterEach, describe, expect, it } from 'vitest';
import itemsFixture from '../support/fixtures/items.json';
import { buttonsFor } from '../../src/ui/item-tab';
import { RUN_ANYWAY_HINT } from '../../src/model/needs-you';
import { disposeHarnesses, panelHarness } from '../support/panel-harness';
import type { StubRequest, StubResponse } from '../support/stub-server';
import type { ItemTabState } from '../../src/model/item-tab-protocol';
import type { ItemsResponse, WorkItem } from '../../src/model/work-items';

afterEach(disposeHarnesses);

const JIRA = 'Jira HB-1 could not be loaded (auth error) — fix access or choose Run anyway';
const GITHUB = 'GitHub is not usable: gh api user failed (exit 1)';
const ITEM = 'pr:acme/web#102';
const SESSION = 'pr-acme-web-102';

function itemsWith(note: string | null): ItemsResponse {
  const body = JSON.parse(JSON.stringify(itemsFixture)) as ItemsResponse;
  const item = body.items.find((candidate) => candidate.id === ITEM) as WorkItem;
  item.attention = { ...item.attention, reasons: ['needs_input', 'review_ready'] as never };
  item.agents = [{ ...item.agents[0], phase: 'ready', needsYou: true, agentNote: note }];
  return body;
}

/** The engine with `pr:acme/web#102`'s review blocked by the preflight. */
function blockedEngine(
  note: string | null,
  extra: (request: StubRequest) => StubResponse | undefined = () => undefined,
): (request: StubRequest) => StubResponse | undefined {
  const items = itemsWith(note);
  const item = items.items.find((candidate) => candidate.id === ITEM);
  return (request) => {
    if (request.method === 'GET' && request.path === '/items') return { status: 200, body: items };
    if (request.method === 'GET' && request.path === '/items/pr/acme/web/102') {
      return {
        status: 200,
        body: { item, ticket: null, ticketError: null, artifacts: { [SESSION]: [] } },
      };
    }
    return extra(request);
  };
}

function tabStateOf(note: string | null): ItemTabState {
  const item = itemsWith(note).items.find((candidate) => candidate.id === ITEM) as WorkItem;
  return {
    itemId: item.id,
    title: item.title,
    needsYou: item.needsYou,
    lists: item.lists,
    chips: [],
    focus: { kind: 'ticket' },
    selectedSessionId: SESSION,
    agents: item.agents.map((a) => ({ ...a, glyph: '', artifacts: [] })),
    prs: item.prs.map((pr) => ({ ...pr, state: 'open', ci: '', reviewers: [], checks: [] })),
    ticket: null,
    ticketError: null,
    buttons: [],
    parts: [],
    blocked: note === null ? null : { note, runAnyway: note.startsWith('Jira ') },
  } as unknown as ItemTabState;
}

describe('buttonsFor — Run anyway', () => {
  it('a `Jira …` block offers Run anyway, enabled, with its hint', () => {
    const button = buttonsFor(tabStateOf(JIRA)).find((b) => b.id === 'cgremlin.runAnyway');
    expect(button).toMatchObject({ label: 'Run anyway', enabled: true, hint: RUN_ANYWAY_HINT });
    expect(RUN_ANYWAY_HINT).toBe('Runs without the ticket; the brief will say so');
  });

  it('a `GitHub …` block offers no Run anyway', () => {
    expect(buttonsFor(tabStateOf(GITHUB)).map((b) => b.id)).not.toContain('cgremlin.runAnyway');
  });

  it('no note leaves the row exactly as it was', () => {
    const without = buttonsFor(tabStateOf(null));
    const legacy = tabStateOf(null);
    delete (legacy as { blocked?: unknown }).blocked;
    expect(without.map((b) => b.id)).not.toContain('cgremlin.runAnyway');
    expect(without).toEqual(buttonsFor(legacy));
  });
});

/** The latest state the Item tab rendered. */
function tabRender(h: Awaited<ReturnType<typeof panelHarness>>): ItemTabState {
  const panel = h.host.panels[0];
  if (panel === undefined) throw new Error('no item tab');
  const render = panel.webview.renders().at(-1) as { state: ItemTabState } | undefined;
  if (render === undefined) throw new Error('the tab rendered nothing');
  return render.state;
}

const runPosts = (h: Awaited<ReturnType<typeof panelHarness>>) =>
  h.server.requests.filter((r) => r.method === 'POST' && r.path === `/sessions/${SESSION}/run`);

describe('the Item tab, end to end', () => {
  it('shows the Jira reason, and Run anyway re-issues the same stage with skipJiraCheck', async () => {
    const h = await panelHarness({
      handler: blockedEngine(JIRA, (request) =>
        request.method === 'POST' && request.path === `/sessions/${SESSION}/run`
          ? { status: 202, body: { session: { id: SESSION } } }
          : undefined,
      ),
    });
    await h.host.invoke('cgremlin.openItem', ITEM);
    h.host.panels[0].webview.emit({ type: 'ready' });
    const state = tabRender(h);
    expect(state.blocked?.note).toBe(JIRA);
    expect(state.buttons.map((b) => b.id)).toContain('cgremlin.runAnyway');

    h.host.panels[0].webview.emit({ type: 'command', command: 'cgremlin.runAnyway', arg: ITEM });
    await h.settle();

    expect(runPosts(h).map((r) => r.body)).toEqual([{ stage: 'rereview', skipJiraCheck: true }]);
  });

  it('a GitHub block shows the reason and has no Run anyway; the command refuses to send', async () => {
    const h = await panelHarness({ handler: blockedEngine(GITHUB) });
    await h.host.invoke('cgremlin.openItem', ITEM);
    h.host.panels[0].webview.emit({ type: 'ready' });
    const state = tabRender(h);
    expect(state.blocked?.note).toBe(GITHUB);
    expect(state.buttons.map((b) => b.id)).not.toContain('cgremlin.runAnyway');

    await h.host.invoke('cgremlin.runAnyway', ITEM);
    expect(runPosts(h)).toEqual([]);
  });

  it('a Run anyway the engine blocks again (200, not started) says so', async () => {
    const h = await panelHarness({
      handler: blockedEngine(JIRA, (request) =>
        request.method === 'POST' && request.path === `/sessions/${SESSION}/run`
          ? { status: 200, body: { session: { id: SESSION } } }
          : undefined,
      ),
    });
    await h.host.invoke('cgremlin.runAnyway', ITEM);
    const warned = h.host.calls
      .filter((call) => call.kind === 'showWarningMessage')
      .map((call) => String(call.args[0]));
    expect(warned.join(' ')).toContain('did not start');
  });

  it('the strip says the note, not the bare "needs input"', async () => {
    const h = await panelHarness({ handler: blockedEngine(JIRA) });
    expect(h.state().needsYou.find((entry) => entry.id === ITEM)?.reason).toBe(JIRA);
  });
});

describe('carry-over 1 — a blocked start is not a running one', () => {
  const blockedStart = (path: string) =>
    (request: StubRequest): StubResponse | undefined =>
      request.method === 'POST' && request.path === path
        ? { status: 200, body: { session: { id: 'x' }, created: true, started: false } }
        : undefined;

  it('Start review answered started:false leaves no optimistic running state', async () => {
    const id = 'pr:acme/web#101';
    const h = await panelHarness({ handler: blockedStart('/items/pr/acme/web/101/agents') });
    await h.host.invoke('cgremlin.startReview', id);
    const meta = h.rowOf(id)?.meta ?? [];
    expect(meta.some((cell) => cell.kind === 'running')).toBe(false);
    expect(meta.some((cell) => cell.text === '◈ starting')).toBe(false);
    // Still put on screen, so the reason the refresh brings lands where the user is looking.
    expect(h.rowOf(id)?.selected).toBe(true);
  });

  it('Address review answered started:false opens no tab and swaps no workspace', async () => {
    const id = 'pr:acme/web#200';
    const h = await panelHarness({ handler: blockedStart('/items/pr/acme/web/200/agents') });
    await h.host.invoke('cgremlin.addressReview', id);
    expect(h.host.panels).toHaveLength(0);
  });
});
