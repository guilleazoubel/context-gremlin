/**
 * Integration: the Phase 10 panel flows, against a REAL engine.
 *
 * `real-engine.test.ts` proves the four lists and the respond click. This file proves what the
 * panel redesign added on top of them, and it proves them the only way that is worth anything —
 * over the live socket, through the shipping `createUi` wiring, against a REAL git worktree:
 *
 *  - **one click is one decision** (§4): `selectRow` selects, expands, swaps the workspace to the
 *    row's own worktree, and reads that session's changes — exactly one swap and exactly one
 *    `GET /sessions/:id/changes`, not one per consequence;
 *  - **"changes so far" is the worktree's** — one committed file and one dirty file in a real
 *    clone, counted by the engine's own `git diff` and rendered into the row;
 *  - **the storm guard** (§3.3): twenty `attention.changed` frames about somebody else's PR cost
 *    the open row nothing, and one `artifact.changed` about its own session costs exactly one;
 *  - **forward only** (§4): an item that has reached development offers `Start self-review` and
 *    nothing behind it, and that button's request — `{ mode: 'review', selfReview: true }` —
 *    really does create a review session on the user's OWN PR, which the core refuses without it.
 *
 * Its own engine, deliberately. `real-engine.test.ts`'s MG-8 accounting ("exactly one run.started
 * in this suite, and it is the respond click") is a real guard, and a self-review is a second run;
 * putting it on a second engine keeps that accounting exact rather than loosening it. This file
 * does the same accounting for its own engine at the end.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CoreClient, type HttpResult } from '../../src/core-client';
import { SseClient } from '../../src/sse';
import type { SessionView } from '../../src/model/items';
import type { ItemsResponse, WorkItem } from '../../src/model/work-items';
import type { PanelRowView, PanelState } from '../../src/model/panel-protocol';
import { createUi, VIEW_ID, type Ui } from '../../src/ui/wiring';
import { managedWorkspacePath } from '../../src/ui/preview';
import { FakeHost, type FakeWebview } from '../support/fake-host';
import { startFakeJira, type FakeJira } from '../support/fake-jira';
import {
  coreIsBuilt,
  sleep,
  startEngineViaManager,
  waitUntil,
  type CoreHarness,
} from '../support/core-harness';

const JIRA_TOKEN = 'panel-flows-jira-token-do-not-leak';
const TIMEOUT = 30_000;

/** The PR this file is about: MINE, not a draft, and open on a branch the local origin carries. */
const MY_PR_ID = 'pr:fake/repo#5';
const MY_PR_PATH = 'pr/fake/repo/5';
/** A teammate's PR, used only as "somebody else's work" for the storm. */
const OTHER_PR_ID = 'pr:fake/repo#7';

/** The development session this file adds to the seeded four — the row's own worktree. */
const DEV_SESSION_ID = 'dev-fake-repo-5';

/**
 * A client that records what actually reached the socket. Everything in `CoreClient` funnels
 * through `request`, so overriding it once counts every route — which is the only way to say
 * "one `/changes` read" rather than "the row looks right".
 */
class RecordingClient extends CoreClient {
  readonly log: string[] = [];

  override request(method: string, path: string, body?: unknown): Promise<HttpResult> {
    this.log.push(`${method} ${path}`);
    return super.request(method, path, body);
  }

  mark(): number {
    return this.log.length;
  }

  since(mark: number): string[] {
    return this.log.slice(mark);
  }
}

function git(args: string[], cwd: string): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=integration@example.com', '-c', 'user.name=integration', ...args],
    { cwd, encoding: 'utf8' },
  );
}

function lastRender<T>(webview: FakeWebview): T {
  const renders = webview.renders();
  if (renders.length === 0) throw new Error('the host posted no render');
  return (renders[renders.length - 1] as { state: T }).state;
}

/** `[sessionId, stage]` for every `run.started` this engine logged. */
function runStartedLines(stderr: string): [string, string][] {
  return stderr
    .split('\n')
    .filter((line) => line.includes('"type":"run.started"'))
    .map((line) => JSON.parse(line) as { sessionId: string; stage: string })
    .map((entry) => [entry.sessionId, entry.stage]);
}

describe.skipIf(!coreIsBuilt())('integration: the Phase 10 panel flows against a real engine', () => {
  let h: CoreHarness;
  let jira: FakeJira;
  let client: RecordingClient;
  let host: FakeHost;
  let ui: Ui;
  let sse: SseClient;
  let panelView: FakeWebview;
  /** The real clone the development session lives in — one commit ahead, one file dirty. */
  let devWorktree: string;

  beforeAll(async () => {
    jira = await startFakeJira({ apiToken: JIRA_TOKEN });
    h = await startEngineViaManager({ jira: { baseUrl: jira.baseUrl, apiToken: JIRA_TOKEN } });

    // ---- a REAL worktree for the row to be about ---------------------------
    // A clone of the harness's own local origin, so `origin/main` is a real remote-tracking ref
    // and the engine's `git merge-base <base> HEAD` resolves rather than falling back (R-changes).
    // A review session branches from `origin/pr/<n>`, which the mirror fetches out of GitHub's
    // `refs/pull/*/head`. The harness's local origin has no such ref, so PR #5's head ref is
    // written onto it by hand — the same commit its branch points at (`ReviewSessionFactory`).
    const originPath = path.join(h.stateDir, 'origins', `${h.repoSlug}.git`);
    git(['update-ref', 'refs/pull/5/head', 'me/fixture-five'], originPath);

    devWorktree = path.join(h.stateDir, 'wt-dev-5');
    git(['clone', '-q', path.join(h.stateDir, 'origins', `${h.repoSlug}.git`), devWorktree], h.stateDir);
    git(['checkout', '-q', '-b', 'me/fixture-five', 'origin/me/fixture-five'], devWorktree);
    // One COMMITTED file, so `committed` is a number the test chose.
    await writeFile(path.join(devWorktree, 'committed.txt'), 'one\ntwo\nthree\n', 'utf8');
    git(['add', 'committed.txt'], devWorktree);
    git(['commit', '-q', '-m', 'the committed change'], devWorktree);
    // One DIRTY file. It has to be a file git already tracks: `git diff HEAD` — which is what the
    // engine runs for the working tree — never sees an untracked file at all.
    await writeFile(path.join(devWorktree, 'README.md'), '# fixture origin\n\nedited\n', 'utf8');

    // ---- the session that owns it ------------------------------------------
    // Written through the engine's own `POST /sessions` rather than onto disk behind its back, so
    // the document really is one the shipping schema accepts.
    const created = await h.client.request('POST', '/sessions', {
      schemaVersion: 2,
      id: DEV_SESSION_ID,
      createdAt: '2026-09-10T08:00:00.000Z',
      mode: 'development',
      stageStatus: 'active',
      workspace: {
        repoUrl: `https://github.com/${h.repoSlug}.git`,
        worktreePath: devWorktree,
        branch: 'me/fixture-five',
      },
      lineage: { pipelineId: DEV_SESSION_ID, parentSessionId: null, ticket: null },
      agent: { runner: 'claude-code', resumeId: 'resume-dev-5', humanTurn: null },
      lastRun: null,
      pr: {
        repo: h.repoSlug,
        number: 5,
        url: 'https://github.com/fake/repo/pull/5',
        headSha: '5555555555555555555555555555555555555555',
        reviewedSha: null,
        title: 'Fixture PR five (mine, changes requested)',
        author: 'me',
      },
    });
    expect(created.status).toBe(201);

    expect((await h.client.scan()).status).toBe(200);
    await waitUntil(
      () => h.client.items(),
      (listing) => listing.ticketSource.scannedAt !== '' && listing.threadSource.scannedAt !== null,
      { timeoutMs: 20_000, what: 'the Jira and review-thread legs to publish' },
    );

    // ---- the host wiring, exactly as `extension.ts` composes it -------------
    host = new FakeHost();
    // The window is already IN the managed workspace with some other folder open, which is the
    // only state in which a swap is a swap rather than an offer to reload (§5.5).
    host.workspaceFilePath = managedWorkspacePath(h.stateDir);
    host.folders = [path.join(h.worktreesDir, h.seeded.investigation)];
    client = new RecordingClient(h.socketPath);
    ui = createUi({ host, client, notificationLevel: () => 'off', coalesceMs: 0 });
    sse = new SseClient({ socketPath: h.socketPath, backoffMs: [25] });
    sse.on('frame', (frame) => ui.handleFrame(frame));
    expect(await ui.connect()).toBe(true);
    sse.start();
    panelView = host.resolveView(VIEW_ID).webview;
    panelView.emit({ type: 'ready' });
  }, TIMEOUT);

  afterAll(async () => {
    sse?.stop();
    await ui?.dispose();
    await h?.cleanup();
    await jira?.stop();
  }, TIMEOUT);

  function itemOf(listing: ItemsResponse, id: string): WorkItem {
    const found = listing.items.find((item) => item.id === id);
    if (found === undefined) {
      throw new Error(`no work item '${id}' in [${listing.items.map((i) => i.id).join(', ')}]`);
    }
    return found;
  }

  /** The row as the panel would paint it, in whichever of its lists is asked for. */
  function rowOf(list: string, id: string): PanelRowView {
    const state = lastRender<PanelState>(panelView);
    const found = state.sections
      .filter((candidate) => candidate.list === list)
      .flatMap((section) => section.rows)
      .find((row) => row.id === id);
    if (found === undefined) throw new Error(`no ${list} row '${id}' in the panel`);
    return found;
  }

  /** The expanded row's two reads are real round trips over the socket, not microtasks. */
  async function settleDetail(): Promise<void> {
    await ui.settled();
    await sleep(150);
  }

  // -------------------------------------------------------------------------
  it('attaches the development session to the PR item as an agent with a worktree', async () => {
    const listing = await client.items();
    const item = itemOf(listing, MY_PR_ID);
    expect(item.agents.map((agent) => [agent.sessionId, agent.mode])).toEqual([
      [DEV_SESSION_ID, 'development'],
    ]);
    expect(item.agents[0]?.worktreePath).toBe(devWorktree);
    // The row the rest of this file clicks really is in `myWork` — the forward-only ladder is a
    // rule about MY work, and a parking-lot row would be a different question entirely.
    expect(item.lists.sort()).toEqual(['myWork', 'waitingForReview']);
  }, TIMEOUT);

  /**
   * §4, amended: one click, three consequences, and each of them exactly once. The defect this
   * pins is the cheap version of the feature — a select that repaints, a separate expand that
   * refetches, and a swap that fires again on the next render.
   */
  it('a click on a row selects it, expands it, swaps the workspace ONCE and reads its changes ONCE', async () => {
    const mark = client.mark();
    const swapsBefore = host.callsOf('updateWorkspaceFolders').length;

    panelView.emit({ type: 'selectRow', id: MY_PR_ID, list: 'myWork' });
    await settleDetail();

    // One swap, naming the row's OWN worktree — not the seeded one the window started on.
    const swaps = host.callsOf('updateWorkspaceFolders').slice(swapsBefore);
    expect(swaps).toHaveLength(1);
    expect(swaps[0].args[2]).toEqual([{ uri: devWorktree, name: path.basename(devWorktree) }]);
    expect(host.workspaceFolders()).toEqual([devWorktree]);

    // One `/changes`, for the session the row is, and one detail read for its artifact times.
    const requests = client.since(mark);
    expect(requests.filter((r) => r.includes('/changes'))).toEqual([
      `GET /sessions/${DEV_SESSION_ID}/changes`,
    ]);
    expect(requests.filter((r) => r === `GET /items/${MY_PR_PATH}`)).toHaveLength(1);

    // …and the panel repainted the row as selected AND expanded, from one message.
    const row = rowOf('myWork', MY_PR_ID);
    expect(row.selected).toBe(true);
    expect(row.expanded).toBe(true);
    // The three lifecycle slots exist whether or not the item has an agent in each (§4).
    expect(row.lifecycle.map((slot) => [slot.stage, slot.state])).toEqual([
      ['investigation', 'notStarted'],
      ['development', 'done'],
      ['review', 'notStarted'],
    ]);
  }, TIMEOUT);

  /**
   * The number the row shows is the WORKTREE's, computed by the engine's own `git diff` against
   * the PR's base — not a field of the PR, and not a fabricated zero (MG-12).
   */
  it('renders the committed and working-tree counts of a real worktree into the expanded row', async () => {
    // What the engine answers, first — so the row below is checked against git and not itself.
    const changes = await h.client.changes(DEV_SESSION_ID);
    expect(changes).not.toBeNull();
    expect(changes?.baseResolved).toBe(true);
    expect(changes?.committed).toEqual({ files: 1, additions: 3, deletions: 0 });
    expect(changes?.workingTree).toEqual({ files: 1, additions: 2, deletions: 0 });

    const row = rowOf('myWork', MY_PR_ID);
    expect(row.changes).toEqual({
      committed: '1 file +3/−0',
      workingTree: '1 file +2/−0',
    });
  }, TIMEOUT);

  /**
   * §3.3's storm guard. Every SSE frame schedules a refresh, so without a signature the open row
   * would pay two engine round trips per frame for work it is not about. Twenty frames, and the
   * open row costs nothing — then one frame that really is about it costs exactly one read.
   */
  it('pays nothing for twenty frames about another PR, and exactly one for a frame about its own', async () => {
    expect(rowOf('myWork', MY_PR_ID).expanded).toBe(true);
    const quiet = client.mark();

    for (let at = 0; at < 20; at += 1) {
      ui.handleFrame({ event: 'attention.changed', data: { id: OTHER_PR_ID } });
      host.flushTimeouts();
      await ui.settled();
    }
    await settleDetail();

    const during = client.since(quiet);
    expect(during.filter((request) => request.includes('/changes'))).toEqual([]);
    expect(during.filter((request) => request === `GET /items/${MY_PR_PATH}`)).toEqual([]);
    // The refreshes themselves DID happen — the guard is about the open row, not about the panel
    // going to sleep.
    expect(during.filter((request) => request === 'GET /items').length).toBeGreaterThan(0);

    // An artifact of this row's own session is the one change a snapshot comparison cannot see,
    // so it invalidates by hand — and costs exactly one read of each.
    const named = client.mark();
    ui.handleFrame({
      event: 'artifact.changed',
      data: { sessionId: DEV_SESSION_ID, name: 'PLAN.md' },
    });
    host.flushTimeouts();
    await settleDetail();
    const after = client.since(named);
    expect(after.filter((request) => request.includes('/changes'))).toHaveLength(1);
    expect(after.filter((request) => request === `GET /items/${MY_PR_PATH}`)).toHaveLength(1);
  }, TIMEOUT);

  /**
   * Forward only (§4). The item has reached development — it has a development agent AND a PR,
   * which is that stage's output — so the only stage on offer is the one after it. The two verbs
   * that would 409 or produce a nonsensical session are simply not there (P0-2).
   */
  it('offers Start self-review on my own PR, and nothing behind it', () => {
    const row = rowOf('myWork', MY_PR_ID);
    const commands = row.actions.map((action) => action.command);
    expect(commands).not.toContain('cgremlin.startInvestigation');
    expect(commands).not.toContain('cgremlin.startDevelopment');

    const start = row.actions.find((action) => action.command === 'cgremlin.startReview');
    // The wording says what it is: the core needs `selfReview` for this one, and a button that
    // said "Start review" would be describing somebody else's change.
    expect(start).toMatchObject({ label: 'Start self-review', placement: 'primary' });

    // The slot agrees with the button, because it IS the button (P0-2): one rule, one place.
    const slots = row.lifecycle;
    expect(slots.filter((slot) => slot.start !== null).map((slot) => slot.stage)).toEqual(['review']);
    expect(slots.find((slot) => slot.stage === 'review')?.start?.label).toBe('Start self-review');
  });

  it('refuses a review of my own PR without the flag, and creates one WITH it (selfReview)', async () => {
    // The control: the core's own 409 is what makes `selfReview` a deliberate act rather than a
    // field nobody notices.
    const refused = await client.startAgent(MY_PR_PATH, { mode: 'review' });
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('the engine never reviews its own PRs');

    const created = await client.startAgent(MY_PR_PATH, { mode: 'review', selfReview: true });
    expect(created.status).toBe(202);
    const body = created.body as { session: SessionView; created: boolean; started: boolean };
    expect(body).toMatchObject({ created: true, started: true });
    expect(body.session.mode).toBe('review');
    expect(body.session.pr).toMatchObject({ repo: h.repoSlug, number: 5, author: 'me' });
    // The flag is recorded ON the review session, which is what lets the brief say so later.
    expect((body.session.lineage as { selfReview?: boolean }).selfReview).toBe(true);

    // It really is a review of MY PR, and the engine really started it.
    const started = await waitUntil(
      async () => runStartedLines(h.stderr()),
      (lines) => lines.length > 0,
      { timeoutMs: 20_000, what: 'the review run to start' },
    );
    expect(started).toEqual([[body.session.id, 'review']]);

    // The brief the self-review prompt writes says which kind of review this is.
    const brief = await waitUntil(
      () => h.client.artifactText(body.session.id, 'BRIEF.md').catch(() => ''),
      (text) => text !== '',
      { timeoutMs: 20_000, what: 'the self-review BRIEF.md' },
    );
    expect(brief).toContain('self-review');
  }, TIMEOUT);

  /** This file's own MG-8: the self-review above is the ONLY run anything here started. */
  it('started exactly one run, and it is the self-review', async () => {
    const started = runStartedLines(h.stderr());
    expect(started).toHaveLength(1);
    expect(started[0][1]).toBe('review');
    // And the reads really were reads.
    await client.items();
    await client.item(MY_PR_PATH);
    expect(runStartedLines(h.stderr())).toHaveLength(1);
    // Nothing here ever claimed a conversation or opened a terminal either (R42).
    expect(host.terminals).toHaveLength(0);
    expect((await h.client.conversation(DEV_SESSION_ID)).claimed).toBe(false);
    // The dirty file is still dirty: reading a worktree never writes to it.
    expect(await readFile(path.join(devWorktree, 'README.md'), 'utf8')).toContain('edited');
  }, TIMEOUT);
});
