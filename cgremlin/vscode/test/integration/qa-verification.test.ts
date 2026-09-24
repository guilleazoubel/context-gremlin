/**
 * Phase 15 C2 — QA verification, end to end against a REAL engine.
 *
 * Nothing about the core is stubbed: the bundled `engine/engine.js` boots through the shipping
 * manager, and the extension's own `CoreClient` drives it. What is faked sits strictly outside
 * the engine — `gh` (a committed script on PATH), Jira (a stub HTTP server the real adapter
 * talks to), `claude` (a script that writes the `QA.md` a verification would write), and the QA
 * environment itself (a local HTTP server standing in for it).
 *
 * **No request is ever made to a real QA deployment.** `qa.url` always points at 127.0.0.1.
 *
 * Guards: MG-22 (exactly once per entry), MG-23 (`autoVerify:false`), MG-24 (a refusal is a
 * `skipped`, never an `error`), MG-30 (`auth:'none'` and an unreachable QA create nothing),
 * MG-32 (the artifact route redacts), MG-37 (a Jira outage writes no status).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  commitOnOrigin,
  coreIsBuilt,
  mergedPrState,
  startEngineViaManager,
  type CoreHarness,
} from '../support/core-harness';
import { startFakeJira, type FakeJira } from '../support/fake-jira';
import { startFakeQa, type FakeQa } from '../support/fake-qa';
import { toRow, type ItemsResponse, type WorkItem } from '../../src/model/work-items';
import { itemActionFacts, rowActions } from '../../src/model/row-actions';

const TICKET = 'APP-42';
const PR_NUMBER = 900;
const QA_REPOS = ['fake/repo'];

const READY_MD = [
  '# QA Verification: APP-42 — A ticket with no pull request and no agent',
  '**Verdict:** ✅ Ready to deploy — every acceptance criterion holds.',
  '',
  '## QA Verdict',
  '- Verdict: ✅ Ready to deploy',
  '- Blocking problems: 0',
  '',
].join('\n');

const NOT_READY_MD = [
  '# QA Verification: APP-42 — A ticket with no pull request and no agent',
  '**Verdict:** ❌ Not ready — the list never loads.',
  '',
  '## QA Verdict',
  '- Verdict: ❌ Not ready',
  '- Blocking problems: 1',
  '',
].join('\n');

/** MG-32: what a careless agent pastes into its report. Neither value may leave the engine. */
const LEAKY_MD = [
  NOT_READY_MD,
  '## Problems found',
  'Authorization: Bearer sk-live-abcdef0123456789',
  'cookie: __session=eyJhbGciOiJIUzI1NiJ9.leaked-session-value',
  '',
].join('\n');

const live: { harness?: CoreHarness; jira?: FakeJira; qa?: FakeQa }[] = [];

afterEach(async () => {
  for (const one of live.splice(0)) {
    await one.harness?.cleanup();
    await one.jira?.stop();
    await one.qa?.stop();
  }
});

interface Opts {
  auth?: 'vercel-bypass' | 'none';
  autoVerify?: boolean;
  /** Point `qa.url` at a port nothing listens on (R83's unreachable case). */
  unreachable?: boolean;
  verdict?: string;
}

async function boot(opts: Opts = {}): Promise<{ h: CoreHarness; jira: FakeJira; qa: FakeQa }> {
  const qa = await startFakeQa();
  const jira = await startFakeJira({ apiToken: 'integration-token' });
  const h = await startEngineViaManager({
    jira: { baseUrl: jira.baseUrl, apiToken: 'integration-token', projectKeys: ['APP'] },
    qa: {
      url: opts.unreachable ? qa.deadUrl : qa.url,
      auth: opts.auth ?? 'vercel-bypass',
      autoVerify: opts.autoVerify ?? true,
    },
    prStates: { [`fake/repo#${PR_NUMBER}`]: mergedPrState(PR_NUMBER, TICKET) },
    qaVerdict: opts.verdict ?? READY_MD,
  });
  live.push({ harness: h, jira, qa });
  return { h, jira, qa };
}

/** The work item the panel would draw, straight off the engine's own `/items`. */
async function itemOf(h: CoreHarness): Promise<WorkItem> {
  const items = (await h.client.items()) as ItemsResponse;
  const found = items.items.find((i) => i.ticket?.key === TICKET);
  if (found === undefined) throw new Error(`no ${TICKET} item in /items`);
  return found;
}

interface QaReport {
  scannedAt: string | null;
  started: string[];
  skipped: { ticket: string; why: string }[];
  errors: { ticket: string; error: string }[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * One tick. `POST /prs/scan` runs the inventory scan and then starts the QA leg WITHOUT awaiting
 * it (R34's leg discipline), so the `qa` block a scan answers with is the PREVIOUS leg's report
 * — and a second scan while one is in flight starts nothing at all (single-flight). Every
 * assertion below therefore pumps ticks until what it is waiting for shows up, rather than
 * counting them.
 */
async function scan(h: CoreHarness): Promise<QaReport> {
  const body = (await h.client.scan()).body as { qa?: QaReport };
  return body.qa ?? { scannedAt: null, started: [], skipped: [], errors: [] };
}

/** One scan, then long enough for the leg it started to finish. */
async function settle(h: CoreHarness): Promise<void> {
  await scan(h);
  await sleep(1_200);
}

async function pump(
  h: CoreHarness,
  want: (report: QaReport) => boolean | Promise<boolean>,
  timeoutMs = 30_000,
): Promise<QaReport> {
  const deadline = Date.now() + timeoutMs;
  let last: QaReport = { scannedAt: null, started: [], skipped: [], errors: [] };
  for (;;) {
    last = await scan(h);
    if (await want(last)) return last;
    if (Date.now() >= deadline) {
      throw new Error(`the QA leg never got there; last report: ${JSON.stringify(last)}`);
    }
    await sleep(400);
  }
}

async function qaSessions(h: CoreHarness): Promise<{ id: string; stageStatus: string }[]> {
  const body = (await h.client.sessions()) as { sessions: { id: string; mode: string; stageStatus: string }[] };
  return body.sessions.filter((s) => s.mode === 'qa');
}

async function waitForQaSession(h: CoreHarness, timeoutMs = 30_000): Promise<{ id: string; stageStatus: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await qaSessions(h);
    if (found.length > 0) return found[0];
    if (Date.now() >= deadline) throw new Error('no qa session was created');
    await sleep(100);
  }
}

async function waitForPhase(h: CoreHarness, id: string, phase: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let seen = '';
  for (;;) {
    seen = (await qaSessions(h)).find((s) => s.id === id)?.stageStatus ?? '';
    if (seen === phase) return;
    if (Date.now() >= deadline) throw new Error(`session ${id} is '${seen}', not '${phase}'`);
    await sleep(100);
  }
}

describe.skipIf(!coreIsBuilt())('QA verification end to end', () => {
  it('the manual click creates and starts a QA session, and the row says so', async () => {
    const { h } = await boot();
    await settle(h);
    const item = await itemOf(h);
    expect(rowActions(itemActionFacts(item, QA_REPOS), 'myWork').map((a) => a.label))
      .toContain('Verify in QA');

    const started = await h.client.startAgent(`pr/fake/repo/${PR_NUMBER}`, { mode: 'qa' });
    expect(started.status).toBe(202);
    const session = await waitForQaSession(h);

    const running = await itemOf(h);
    const texts = toRow(running, 'myWork', Date.now()).meta.map((c) => c.text);
    expect(texts).toContain('merged');
    expect(texts.some((t) => t.startsWith('⛋ '))).toBe(true);
    expect(session.id).toMatch(/^qa-repo-APP-42-/);
  }, 90_000);

  it('a not-ready verdict ends not_ready, raises qa_not_ready and makes the row need you', async () => {
    const { h } = await boot({ verdict: NOT_READY_MD });
    await settle(h);
    await h.client.startAgent(`pr/fake/repo/${PR_NUMBER}`, { mode: 'qa' });
    const session = await waitForQaSession(h);
    await waitForPhase(h, session.id, 'not_ready');

    const item = await itemOf(h);
    expect(item.attention.reasons).toContain('qa_not_ready');
    expect(item.needsYou).toBe(true);
    expect(toRow(item, 'myWork', Date.now()).meta).toContainEqual({
      kind: 'agentPhase', text: '⛋ QA failed', tone: 'bad',
    });
  }, 90_000);

  it('a ready verdict ends ready, and the row is quiet but says so', async () => {
    const { h } = await boot({ verdict: READY_MD });
    await settle(h);
    await h.client.startAgent(`pr/fake/repo/${PR_NUMBER}`, { mode: 'qa' });
    const session = await waitForQaSession(h);
    await waitForPhase(h, session.id, 'ready');

    const item = await itemOf(h);
    expect(item.attention.reasons).not.toContain('qa_not_ready');
    expect(toRow(item, 'myWork', Date.now()).meta).toContainEqual({
      kind: 'agentPhase', text: '⛋ QA passed',
    });
  }, 90_000);

  it('MG-32 — the artifact route redacts a bearer token and a session cookie in QA.md', async () => {
    const { h } = await boot({ verdict: LEAKY_MD });
    await settle(h);
    await h.client.startAgent(`pr/fake/repo/${PR_NUMBER}`, { mode: 'qa' });
    const session = await waitForQaSession(h);
    await waitForPhase(h, session.id, 'not_ready');

    const text = await h.client.artifactText(session.id, 'QA.md');
    expect(text).not.toContain('sk-live-abcdef0123456789');
    expect(text).not.toContain('eyJhbGciOiJIUzI1NiJ9.leaked-session-value');
    expect(text).toContain('<redacted>');
    // The file on disk is untouched: redaction is a boundary, not a rewrite.
    const onDisk = await readFile(path.join(h.sessionsDir, session.id, 'QA.md'), 'utf8');
    expect(onDisk).toContain('sk-live-abcdef0123456789');
  }, 90_000);

  it('MG-22/MG-24 — the automatic leg fires exactly once for an observed entry into UAT', async () => {
    const { h, jira } = await boot();
    // Tick one SEEDS the record (R77 as amended): the ticket is not in a QA status yet.
    await settle(h);
    expect(await qaSessions(h)).toEqual([]);

    jira.setStatus(TICKET, 'UAT', 'indeterminate');
    const fired = await pump(h, async () => (await qaSessions(h)).length > 0);
    expect(fired.errors).toEqual([]);
    const session = (await qaSessions(h))[0];
    await waitForPhase(h, session.id, 'ready');

    // Three more ticks at the same shas and the same ordinal start nothing more.
    await settle(h);
    await settle(h);
    await settle(h);
    expect((await qaSessions(h)).map((s) => s.id)).toEqual([session.id]);
  }, 120_000);

  it('MG-30 — an unreachable QA skips with a reason and creates no session', async () => {
    const { h, jira } = await boot({ unreachable: true });
    await settle(h);
    jira.setStatus(TICKET, 'UAT', 'indeterminate');
    const report = await pump(h, (r) => r.skipped.some((s) => s.why.includes('qa unreachable')));
    expect(await qaSessions(h)).toEqual([]);
    expect(report.errors).toEqual([]);
  }, 90_000);

  it("MG-30/R81 — auth:'none' never auto-starts, and the manual click still does", async () => {
    const { h, jira } = await boot({ auth: 'none' });
    await settle(h);
    jira.setStatus(TICKET, 'UAT', 'indeterminate');
    const report = await pump(h, (r) => r.skipped.some((s) => s.why === 'no qa test account'));
    expect(await qaSessions(h)).toEqual([]);
    expect(report.errors).toEqual([]);

    const started = await h.client.startAgent(`pr/fake/repo/${PR_NUMBER}`, { mode: 'qa' });
    expect(started.status).toBe(202);
    expect((await waitForQaSession(h)).id).toBeTruthy();
  }, 90_000);

  it('MG-23 — autoVerify:false starts nothing at all', async () => {
    const { h, jira } = await boot({ autoVerify: false });
    await settle(h);
    jira.setStatus(TICKET, 'UAT', 'indeterminate');
    await settle(h);
    await settle(h);
    await settle(h);
    expect(await qaSessions(h)).toEqual([]);
  }, 90_000);
});

/**
 * Phase 16 — merging is not deploying, end to end against the real engine.
 *
 * The QA stub now serves `/api/health` with the sha it is "running", exactly
 * as the real one does. The origin's `main` carries two commits: the merged
 * PR's own sha, and the commit before it — a build cut before the change
 * landed. Nothing here talks to a real QA deployment; `qa.url` is loopback.
 */
describe.skipIf(!coreIsBuilt())('QA verification follows the deployed build', () => {
  const sessionFile = async (h: CoreHarness, id: string, name: string): Promise<string | null> => {
    try {
      return await readFile(path.join(h.sessionsDir, id, name), 'utf8');
    } catch {
      return null;
    }
  };

  it('waits for the build that contains the change, then verifies once per build', async () => {
    const { h, jira, qa } = await boot();
    // A build cut BEFORE the change landed.
    qa.setVersion(h.originShas.parent);
    await settle(h);
    jira.setStatus(TICKET, 'UAT', 'indeterminate');

    const waiting = await pump(h, (r) => r.skipped.some((s) => s.why.includes('not in the qa build yet')));
    expect(waiting.errors).toEqual([]);
    expect(await qaSessions(h)).toEqual([]);
    const awaitingRow = toRow(await itemOf(h), 'myWork', Date.now()).meta;
    expect(awaitingRow.find((c) => c.kind === 'qaDeploy')?.text).toBe('awaiting qa deploy');

    // The build that contains it: exactly one verification.
    qa.setVersion(h.originShas.head);
    await pump(h, async () => (await qaSessions(h)).length > 0);
    const session = (await qaSessions(h))[0];
    await waitForPhase(h, session.id, 'ready');
    await settle(h);
    await settle(h);
    expect((await qaSessions(h)).map((s) => s.id)).toEqual([session.id]);
    const verifiedRow = toRow(await itemOf(h), 'myWork', Date.now()).meta;
    expect(verifiedRow.find((c) => c.kind === 'qaDeploy')?.text).toBe(`build ${h.originShas.head.slice(0, 7)}`);

    // A NEW cut is a new question: one more verification, on the same session,
    // and the previous QA.md is still readable as QA-v1.md.
    qa.setVersion(commitOnOrigin(h.originPath, 'a later build'));
    await pump(h, async () => (await sessionFile(h, session.id, 'QA-v1.md')) !== null, 60_000);
    await waitForPhase(h, session.id, 'ready');
    expect((await qaSessions(h)).map((s) => s.id)).toEqual([session.id]);
    expect(await sessionFile(h, session.id, 'QA-v1.md')).toContain('Ready to deploy');
  }, 180_000);

  it('a manual re-verify after a ✅ runs again and keeps the previous QA.md', async () => {
    const { h, qa } = await boot();
    qa.setVersion(h.originShas.head);
    await settle(h);
    await h.client.startAgent(`pr/fake/repo/${PR_NUMBER}`, { mode: 'qa' });
    const session = await waitForQaSession(h);
    await waitForPhase(h, session.id, 'ready');

    // The row still offers it — a verdict is never a reason to hide the ask.
    const item = await itemOf(h);
    expect(rowActions(itemActionFacts(item, QA_REPOS), 'myWork').map((a) => a.label))
      .toContain('Verify in QA again');

    const again = await h.client.startAgent(`pr/fake/repo/${PR_NUMBER}`, { mode: 'qa' });
    expect(again.status).toBe(202);
    await waitForPhase(h, session.id, 'ready');
    expect(await sessionFile(h, session.id, 'QA-v1.md')).toContain('Ready to deploy');
    expect(await sessionFile(h, session.id, 'QA.md')).toContain('Ready to deploy');
  }, 180_000);
});
