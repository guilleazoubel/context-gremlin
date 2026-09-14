/**
 * Integration: starting work from a TICKET-ONLY row, against a REAL engine.
 *
 * The bug this file exists for: a `myWork` row that is a Jira ticket with no PR and no session
 * offers `Start investigation` / `Start development`, and clicking one appeared to do nothing.
 * Everything below is driven the way the user drives it — a `command` message out of the panel
 * webview, through the shipping `createUi` wiring — and asserted against the engine's own state.
 *
 * Its own engine, deliberately: `real-engine.test.ts` and `panel-flows.test.ts` each account for
 * every `run.started` on theirs, and the clicks here are runs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { CoreClient, type HttpResult } from '../../src/core-client';
import { SseClient } from '../../src/sse';
import type { SessionView } from '../../src/model/items';
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

const JIRA_TOKEN = 'start-from-ticket-jira-token-do-not-leak';
const TIMEOUT = 60_000;

/** The fixture ticket with no PR and no session: "nothing has started yet". */
const TICKET_ID = 'ticket:APP-42';
const TICKET_PATH = 'ticket/APP-42';
/** Two repos, so the quick pick is a real question rather than a formality. */
const REPOS = ['fake/repo', 'other/repo'];

class RecordingClient extends CoreClient {
  readonly log: { method: string; path: string; body?: unknown }[] = [];
  /** The engine's own answers, for the one route whose CONTRACT this file is about. */
  readonly answers = new Map<string, HttpResult>();

  override async request(method: string, requestPath: string, body?: unknown): Promise<HttpResult> {
    this.log.push({ method, path: requestPath, body });
    const result = await super.request(method, requestPath, body);
    this.answers.set(`${method} ${requestPath}`, result);
    return result;
  }

  mark(): number {
    return this.log.length;
  }

  since(mark: number): { method: string; path: string; body?: unknown }[] {
    return this.log.slice(mark);
  }
}

function lastRender<T>(webview: FakeWebview): T {
  const renders = webview.renders();
  if (renders.length === 0) throw new Error('the host posted no render');
  return (renders[renders.length - 1] as { state: T }).state;
}

function runStartedLines(stderr: string): [string, string][] {
  return stderr
    .split('\n')
    .filter((line) => line.includes('"type":"run.started"'))
    .map((line) => JSON.parse(line) as { sessionId: string; stage: string })
    .map((entry) => [entry.sessionId, entry.stage]);
}

describe.skipIf(!coreIsBuilt())('integration: starting work from a ticket-only row', () => {
  let h: CoreHarness;
  let jira: FakeJira;
  let client: RecordingClient;
  let host: FakeHost;
  let ui: Ui;
  let sse: SseClient;
  let panelView: FakeWebview;

  beforeAll(async () => {
    jira = await startFakeJira({ apiToken: JIRA_TOKEN });
    h = await startEngineViaManager({
      repos: REPOS,
      jira: { baseUrl: jira.baseUrl, apiToken: JIRA_TOKEN },
    });
    expect((await h.client.scan()).status).toBe(200);
    await waitUntil(
      () => h.client.items(),
      (listing) => listing.ticketSource.scannedAt !== '' && listing.threadSource.scannedAt !== null,
      { timeoutMs: 20_000, what: 'the Jira and review-thread legs to publish' },
    );

    host = new FakeHost();
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

  function rowOf(list: string, id: string): PanelRowView {
    const state = lastRender<PanelState>(panelView);
    const found = state.sections
      .filter((candidate) => candidate.list === list)
      .flatMap((section) => section.rows)
      .find((row) => row.id === id);
    if (found === undefined) throw new Error(`no ${list} row '${id}' in the panel`);
    return found;
  }

  async function settle(): Promise<void> {
    host.flushTimeouts();
    await ui.settled();
    await sleep(150);
    host.flushTimeouts();
    await ui.settled();
  }

  it('offers both entry points on a ticket with no PR and no session', () => {
    const row = rowOf('myWork', TICKET_ID);
    expect(row.actions.map((action) => action.command)).toEqual(
      expect.arrayContaining(['cgremlin.startInvestigation', 'cgremlin.startDevelopment']),
    );
    const slot = row.lifecycle.find((candidate) => candidate.stage === 'investigation');
    // The row is collapsed, so it has no slots yet — the actions are the contract here.
    expect(slot ?? null).toBeNull();
  });

  it('refuses a ticket-only start with no repoUrl, and says why', async () => {
    const refused = await client.startAgent(TICKET_PATH, { mode: 'investigation' });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('repoUrl');
  }, TIMEOUT);

  it('asks which repo, creates the investigation, STARTS it and lights the slot', async () => {
    host.quickPickAnswers = ['fake/repo'];
    const mark = client.mark();

    panelView.emit({ type: 'command', command: 'cgremlin.startInvestigation', id: TICKET_ID });

    const session = await waitUntil(
      async () =>
        (await h.client.sessions()).sessions.find(
          (s) => s.mode === 'investigation' && s.lineage.ticket === 'APP-42',
        ) ?? null,
      (found) => found !== null,
      { timeoutMs: 30_000, what: 'the investigation session for APP-42' },
    );
    const id = (session as SessionView).id;

    // The quick pick really was asked, over the configured repos.
    const picks = host.callsOf('showQuickPick');
    expect(picks).toHaveLength(1);
    expect(picks[0].args[0]).toEqual(REPOS);

    // ONE request, carrying the repo the user picked.
    const agents = client.since(mark).filter((r) => r.path.endsWith('/agents'));
    expect(agents).toEqual([
      {
        method: 'POST',
        path: `/items/${TICKET_PATH}/agents`,
        body: { mode: 'investigation', repoUrl: 'https://github.com/fake/repo.git' },
      },
    ]);
    expect(host.callsOf('showWarningMessage')).toEqual([]);

    // One request, one 202: created AND started, with the item the click was about. The command
    // is fire-and-forget from the webview's side, so the answer is waited for rather than assumed
    // to have landed by the time the session exists.
    const answer = await waitUntil(
      async () => client.answers.get(`POST /items/${TICKET_PATH}/agents`) ?? null,
      (found) => found !== null && found.status !== 400,
      { timeoutMs: 20_000, what: 'the agents response' },
    );
    expect(answer?.status).toBe(202);
    expect(answer?.body).toMatchObject({ created: true, started: true, item: { id: TICKET_ID } });

    // The click IS the start (R56): the engine logged the findings run.
    const started = await waitUntil(
      async () => runStartedLines(h.stderr()),
      (lines) => lines.length > 0,
      { timeoutMs: 30_000, what: 'the findings run to start' },
    );
    expect(started).toEqual([[id, 'findings']]);

    // The brief carries the ticket (R18).
    const brief = await waitUntil(
      () => h.client.artifactText(id, 'BRIEF.md').catch(() => ''),
      (text) => text !== '',
      { timeoutMs: 30_000, what: 'BRIEF.md' },
    );
    expect(brief).toContain('APP-42');
    expect(brief).toContain('A ticket with no pull request and no agent');
    expect(brief).toContain('TICKET-BODY-APP-42');

    // The row is selected, expanded, and its investigation slot names the session.
    await settle();
    const row = rowOf('myWork', TICKET_ID);
    expect(row.selected).toBe(true);
    expect(row.expanded).toBe(true);
    const slot = row.lifecycle.find((candidate) => candidate.stage === 'investigation');
    expect(slot?.sessionId).toBe(id);

    // …and the workspace followed the new worktree.
    const fresh = (await h.client.request('GET', `/sessions/${id}`)).body as { session: SessionView };
    expect(host.workspaceFolders()).toEqual([fresh.session.workspace.worktreePath]);
  }, TIMEOUT);

  it('remembers the repo for that ticket, so the next start does not ask again', async () => {
    const picksBefore = host.callsOf('showQuickPick').length;
    const mark = client.mark();

    panelView.emit({ type: 'command', command: 'cgremlin.startDevelopment', id: TICKET_ID });

    await waitUntil(
      async () =>
        (await h.client.sessions()).sessions.find(
          (s) => s.mode === 'development' && s.lineage.ticket === 'APP-42',
        ) ?? null,
      (found) => found !== null,
      { timeoutMs: 30_000, what: 'the development session for APP-42' },
    );

    expect(host.callsOf('showQuickPick').length).toBe(picksBefore);
    const agents = client.since(mark).filter((r) => r.path.endsWith('/agents'));
    expect(agents).toEqual([
      {
        method: 'POST',
        path: `/items/${TICKET_PATH}/agents`,
        body: { mode: 'development', repoUrl: 'https://github.com/fake/repo.git' },
      },
    ]);
  }, TIMEOUT);
});
