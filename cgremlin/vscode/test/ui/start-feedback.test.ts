/**
 * "Nothing happened."
 *
 * The user clicked `Start review` on a parking-lot row and the engine DID
 * start it — session created, `queued` → `reviewing`, `run.started`, and
 * `/items` moved the item into `parkingLot.reviewing` with a running review
 * agent. The failure was entirely FEEDBACK: the row silently left the group
 * the user was looking at, nothing said the work had begun, and the next
 * `/items` was a poll away.
 *
 * So a start that WORKED ends with the row on screen — selected, expanded, in
 * its new section — wearing a running marker before any refresh lands. A
 * start that FAILED leaves none of that behind.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { disposeHarnesses, panelHarness } from '../support/panel-harness';
import { fixtures, type StubRequest, type StubResponse } from '../support/stub-server';

const ITEM = 'pr:acme/web#101';
/** A parking-lot row with no agent of ours — the one `Start review` is offered on. */
const REVIEW_PATH = '/items/pr/acme/web/101/agents';

afterEach(disposeHarnesses);

/**
 * The engine as it behaves around a real start: the FIRST `/items` is the
 * plain fixture (no agent — that is the row `Start review` is offered on), and
 * every one after it carries the session the start created.
 */
function engineThatStarts(): (request: StubRequest) => StubResponse | undefined {
  let served = 0;
  return (request) => {
    if (request.method !== 'GET' || request.path !== '/items') return undefined;
    served += 1;
    return served === 1 ? undefined : withRealAgent(request);
  };
}

/** What the engine answers once the review it just started is real. */
function withRealAgent(request: StubRequest): StubResponse | undefined {
  if (request.method !== 'GET' || request.path !== '/items') return undefined;
  const body = JSON.parse(JSON.stringify(fixtures.items)) as {
    items: { id: string; parkingLotGroup: string | null; agents: unknown[] }[];
    lists: { parkingLot: { reviewing: string[]; untouched: string[] } };
  };
  const item = body.items.find((candidate) => candidate.id === ITEM);
  if (item === undefined) throw new Error('fixture');
  item.agents = [
    {
      sessionId: 'pr-acme-web-101-x',
      repo: 'acme/web',
      mode: 'review',
      phase: 'reviewing',
      running: true,
      needsYou: false,
      claimed: false,
      primaryArtifact: null,
      worktreePath: null,
      ref: 'session:pr-acme-web-101-x',
    },
  ];
  item.parkingLotGroup = 'reviewing';
  const lot = body.lists.parkingLot;
  lot.untouched = lot.untouched.filter((id) => id !== ITEM);
  lot.reviewing = [...lot.reviewing, ITEM];
  return { status: 200, body };
}

const refuse = (status: number, body: unknown) =>
  (request: StubRequest): StubResponse | undefined =>
    request.method === 'POST' && request.path === REVIEW_PATH ? { status, body } : undefined;

function rowOf(h: Awaited<ReturnType<typeof panelHarness>>, id: string) {
  return h.state()
    .sections.flatMap((section) => section.rows)
    .find((row) => row.id === id);
}

describe('a start that worked says so, at once', () => {
  it('selects and expands the row, with zero refreshes in between', async () => {
    const h = await panelHarness();
    expect(rowOf(h, ITEM)?.selected).toBe(false);
    const before = h.server.requests.filter((r) => r.method === 'GET' && r.path === '/items').length;

    await h.host.invoke('cgremlin.startReview', ITEM);

    const row = rowOf(h, ITEM);
    expect(row?.selected).toBe(true);
    expect(row?.expanded).toBe(true);
    // The whole point: this is true off the panel's own state, before the
    // refresh the start scheduled has landed.
    expect(
      h.server.requests.filter((r) => r.method === 'GET' && r.path === '/items').length,
    ).toBe(before);
  });

  it('shows the started stage as running on the COLLAPSED row, before /items confirms', async () => {
    const h = await panelHarness();
    await h.host.invoke('cgremlin.startReview', ITEM);

    const meta = rowOf(h, ITEM)?.meta ?? [];
    expect(meta.map((cell) => cell.text)).toContain('◈ starting');
    const running = meta.find((cell) => cell.kind === 'running');
    expect(running?.text).toBe('running');
    expect(running?.tone).toBe('active');
  });

  it('offers no SECOND Start review while the first is in flight', async () => {
    const h = await panelHarness();
    const offered = () => (rowOf(h, ITEM)?.actions ?? []).map((a) => a.command);
    expect(offered()).toContain('cgremlin.startReview');

    await h.host.invoke('cgremlin.startReview', ITEM);

    expect(offered()).not.toContain('cgremlin.startReview');
  });

  it('the optimistic agent is inert: no chat target, no child to open', async () => {
    const h = await panelHarness();
    await h.host.invoke('cgremlin.startReview', ITEM);

    const row = rowOf(h, ITEM);
    expect((row?.actions ?? []).map((a) => a.command)).not.toContain('cgremlin.chat');
    // The Review part exists and says `running`, but addresses no session.
    const part = (row?.parts ?? []).find((p) => p.kind === 'review');
    expect(part?.state).toBe('running');
    expect(part?.childId).toBeNull();
  });

  it('stays where the CORE put it until /items moves it, and follows the move still selected', async () => {
    // Membership is the core's answer (D2): the panel does not invent a
    // section move. What it does is make the row unmistakable where it is,
    // and keep it selected and open when the engine moves it.
    const h = await panelHarness({ handler: engineThatStarts() });
    await h.host.invoke('cgremlin.startReview', ITEM);
    expect(h.sectionOf('parkingLot:untouched')?.rows.map((r) => r.id)).toContain(ITEM);
    expect(rowOf(h, ITEM)?.meta.some((c) => c.kind === 'running')).toBe(true);

    await h.settle();

    expect(h.sectionOf('parkingLot:reviewing')?.rows.map((r) => r.id)).toContain(ITEM);
    const row = rowOf(h, ITEM);
    expect(row?.selected).toBe(true);
    expect(row?.expanded).toBe(true);
  });

  it('hands the row back to the wire the moment /items carries the real agent', async () => {
    const h = await panelHarness({ handler: engineThatStarts() });
    await h.host.invoke('cgremlin.startReview', ITEM);
    expect(rowOf(h, ITEM)?.meta.some((c) => c.text === '◈ starting')).toBe(true);

    await h.settle();

    // The engine's own agent supersedes the optimistic one, phase and all.
    const meta = rowOf(h, ITEM)?.meta ?? [];
    expect(meta.some((c) => c.text === '◈ starting')).toBe(false);
    expect(meta.some((c) => c.text === '◈ reviewing')).toBe(true);
  });
});

describe('a start that failed leaves nothing behind', () => {
  it('a 409 rolls the optimistic running state back and keeps the failure message', async () => {
    const h = await panelHarness({
      handler: refuse(409, { error: { message: 'That PR already has a review session.' } }),
    });

    await h.host.invoke('cgremlin.startReview', ITEM);

    const meta = rowOf(h, ITEM)?.meta ?? [];
    expect(meta.some((cell) => cell.kind === 'running')).toBe(false);
    expect(meta.some((cell) => cell.text === '◈ starting')).toBe(false);
    // The row is offerable again, and the user was told.
    expect((rowOf(h, ITEM)?.actions ?? []).map((a) => a.command)).toContain('cgremlin.startReview');
    const warned = h.host.calls
      .filter((call) => call.kind === 'showWarningMessage')
      .map((call) => String(call.args[0]));
    expect(warned.join(' ')).toContain('already has a review session');
  });
});
