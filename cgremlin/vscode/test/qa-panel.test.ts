/**
 * Phase 15 B1 — the QA verification row.
 *
 * Everything the panel gained for `mode: 'qa'`, asserted where §8 puts it: ONE composer for the
 * collapsed row's state token, ONE rule table for the two verbs, one part in the expanded row,
 * and the artifact label. No module outside `model/row-composition` may say `verifying` — that is
 * `row-composition.guard.test.ts`'s job and it is extended there.
 */
import { describe, expect, it } from 'vitest';
import { artifactLabel, artifactRole, primaryArtifactName } from '../src/model/artifact-labels';
import { itemParts } from '../src/model/item-parts';
import { lifecycleSlots } from '../src/model/lifecycle';
import { itemActionFacts, rowActions } from '../src/model/row-actions';
import { MODE_GLYPH, MODE_LETTER, MODE_NAME, qaStateText } from '../src/model/row-composition';
import {
  buildWorkLists,
  toRow,
  type ItemsResponse,
  type WorkItem,
  type WorkItemAgent,
  type WorkItemPr,
} from '../src/model/work-items';

const REPO = 'aplaceformom/grace-frontend';
const QA_REPOS = [REPO];

function pr(over: Partial<WorkItemPr> = {}): WorkItemPr {
  return {
    repo: REPO, number: 2061, url: `https://github.com/${REPO}/pull/2061`,
    title: 'feat(HB-6210): the landed change', author: 'gennaro', branch: 'feature/HB-6210',
    isDraft: false, isMine: true, reviewDecision: null, humanActivity: null, reviewRequests: null,
    teamActivity: null, updatedAt: '2026-09-15T14:28:21Z', createdAt: '2026-09-09T08:00:00Z',
    changedFiles: 7, additions: 120, deletions: 30, ci: 'success', labels: null, sizeTier: 'M',
    state: 'merged', ...over,
  } as WorkItemPr;
}

function qaAgent(over: Partial<WorkItemAgent> = {}): WorkItemAgent {
  return {
    sessionId: 'qa-grace-frontend-HB-6210-20260915', repo: REPO, mode: 'qa', phase: 'verifying',
    running: true, needsYou: false, claimed: false, primaryArtifact: 'QA.md', worktreePath: null,
    ref: 'session:qa1', ...over,
  } as WorkItemAgent;
}

function item(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'ticket:HB-6210', kind: 'pr+ticket', lists: ['myWork'], demoted: false,
    parkingLotGroup: null, title: 'HB-6210 — Web-content read endpoint', prs: [pr()],
    ticket: {
      key: 'HB-6210', summary: 'Web-content read endpoint', status: 'UAT',
      statusCategory: 'In Progress', url: 'https://jira.invalid/browse/HB-6210',
      assignee: 'guilherme', updatedAt: '2026-09-13T10:00:00.000Z',
    },
    agents: [], needsYou: false, dismissed: false, dismissedAt: null,
    attention: { reasons: [], since: '2026-09-15T16:00:08.000Z', acked: false, refs: [] },
    ...over,
  } as WorkItem;
}

const NOW = Date.parse('2026-09-15T18:00:00.000Z');
const meta = (it: WorkItem): { kind: string; text: string; tone?: string }[] =>
  toRow(it, 'myWork', NOW).meta;

describe('the mode, said once (§8)', () => {
  it('carries a letter, a geometric glyph and a name', () => {
    expect(MODE_LETTER.qa).toBe('Q');
    expect(MODE_GLYPH.qa).toBe('⛋');
    expect(MODE_NAME.qa).toBe('QA verification');
  });

  it('turns every QA phase into the word the row shows', () => {
    expect(qaStateText('verifying')).toBe('verifying');
    // Task 2 — the contract's own verdict label, because `ready` alone is the word EVERY
    // finished agent's phase reads as, and the QA row was indistinguishable from the rest.
    expect(qaStateText('ready')).toBe('ready to deploy');
    expect(qaStateText('not_ready')).toBe('not ready');
    // Gap 1 — a run failure (no verdict was ever reached) reads as its own
    // word now: 'blocked' is reserved for the QA VERDICT of the same name,
    // and conflating the two is exactly the ambiguity Gap 1 removes.
    expect(qaStateText('failed')).toBe('run failed');
    expect(qaStateText('queued')).toBe('queued');
  });

  // Gap 1 — `not_ready` is the one PHASE both real verdicts fold into
  // (R79); the verdict argument is what tells a failed acceptance criterion
  // apart from an agent that could not test at all.
  it('a not_ready phase reads by its own verdict: not ready, or blocked', () => {
    expect(qaStateText('not_ready', 'not_ready')).toBe('not ready');
    expect(qaStateText('not_ready', 'blocked')).toBe('blocked');
    expect(qaStateText('not_ready', null)).toBe('not ready');
    expect(qaStateText('not_ready')).toBe('not ready');
  });

  it('a run failure stays a run failure no matter what verdict is passed', () => {
    expect(qaStateText('failed', 'blocked')).toBe('run failed');
  });

  // Task 2 — a run that is still going, or that died, has no verdict to report whatever the
  // phase it is sitting in says; and a verdict about a build QA has moved past says so.
  it('a live, a dead and a stale verification each say what they are', () => {
    expect(qaStateText('ready', 'ready', { running: true })).toBe('verifying');
    expect(qaStateText('verifying', null, { runOutcome: 'failed' })).toBe('run failed');
    expect(qaStateText('verifying', null, { runOutcome: 'stopped' })).toBe('run stopped');
    expect(qaStateText('ready', 'ready', { staleVerdict: true })).toBe('ready to deploy · older build');
    expect(qaStateText('queued', null, { staleVerdict: true })).toBe('queued');
  });
});

describe('MG-27 — the collapsed row, through the ONE composer', () => {
  it('a landed myWork row mid-verification draws merged, the ticket status, then the QA cell', () => {
    const cells = meta(item({ agents: [qaAgent()] }));
    expect(cells.map((c) => c.kind)).toEqual([
      'repo', 'prState', 'ticketStatus', 'agentPhase', 'age', 'tier', 'size', 'ci',
    ]);
    // Task 2 — one cell, not two: the QA cell carries the live stage itself, so the generic
    // `running` token beside it would only repeat it.
    expect(cells.map((c) => c.text).slice(0, 4)).toEqual([
      'grace-frontend', 'merged', 'UAT', '⛋ QA verifying',
    ]);
  });

  it('a not-ready verdict tones the phase cell bad, and it comes AFTER the ticket status', () => {
    const cells = meta(
      item({ agents: [qaAgent({ phase: 'not_ready', running: false, needsYou: true })], needsYou: true }),
    );
    const kinds = cells.map((c) => c.kind);
    expect(kinds.indexOf('ticketStatus')).toBeLessThan(kinds.indexOf('agentPhase'));
    const phase = cells.find((c) => c.kind === 'agentPhase');
    expect(phase).toEqual({ kind: 'agentPhase', text: '⛋ QA not ready', tone: 'bad' });
  });

  it('a ready verdict is quiet — the word is there, the tone is not', () => {
    const phase = meta(item({ agents: [qaAgent({ phase: 'ready', running: false })] }))
      .find((c) => c.kind === 'agentPhase');
    expect(phase).toEqual({ kind: 'agentPhase', text: '⛋ QA ready to deploy' });
  });

  // Gap 1 — a Blocked verdict (agent could not test) must not read as the
  // same word as a real not-ready verdict: they mean opposite things.
  it('a blocked verdict reads "blocked", distinctly from "not ready"', () => {
    const blocked = meta(
      item({ agents: [qaAgent({ phase: 'not_ready', running: false, needsYou: true, qaVerdict: 'blocked' })] }),
    ).find((c) => c.kind === 'agentPhase');
    expect(blocked).toEqual({ kind: 'agentPhase', text: '⛋ QA blocked', tone: 'bad' });

    const notReady = meta(
      item({ agents: [qaAgent({ phase: 'not_ready', running: false, needsYou: true, qaVerdict: 'not_ready' })] }),
    ).find((c) => c.kind === 'agentPhase');
    expect(notReady).toEqual({ kind: 'agentPhase', text: '⛋ QA not ready', tone: 'bad' });
  });
});

describe('R72 in the panel — a needs-you row lifts above merged work', () => {
  it('orders the not-ready QA row above a live one in needsYouThenRecent', () => {
    const live = item({ id: 'ticket:HB-1', prs: [pr({ number: 1, state: 'open' })] });
    const notReady = item({
      id: 'ticket:HB-2', needsYou: true,
      prs: [pr({ number: 2 })],
      agents: [qaAgent({ phase: 'not_ready', running: false, needsYou: true })],
      attention: { reasons: ['qa_not_ready'], since: '2026-09-15T17:00:00.000Z', acked: false, refs: [] },
    });
    const response = {
      evaluatedAt: '2026-09-15T18:00:00.000Z',
      lists: { parkingLot: { reviewing: [], untouched: [], someoneOnIt: [] }, myWork: ['ticket:HB-1', 'ticket:HB-2'], investigations: [], waitingForReview: [] },
      dismissed: [], items: [live, notReady],
      ticketSource: { kind: 'ok', error: null, scannedAt: null },
      threadSource: { error: null, scannedAt: null },
    } as unknown as ItemsResponse;
    const lists = buildWorkLists({ response, now: NOW });
    expect(lists.myWork.sections[0].rows.map((r) => r.id)).toEqual(['ticket:HB-2', 'ticket:HB-1']);
  });
});

describe('§8 — the two verbs, offered only when the gate passes', () => {
  const facts = (over: Partial<WorkItem> = {}) => itemActionFacts(item(over), QA_REPOS);
  const labels = (over: Partial<WorkItem> = {}, list: 'myWork' | 'waitingForReview' = 'myWork') =>
    rowActions(facts(over), list).map((a) => `${a.label}:${a.placement}`);

  it('lights both verbs on a merged, ticketed item whose repo has a qa.url', () => {
    expect(labels()).toContain('Verify in QA:primary');
    expect(labels()).toContain('Ask about QA:inline');
    expect(labels({}, 'waitingForReview')).toContain('Verify in QA:primary');
  });

  it('MG-41 — a ticket whose only PR is closed offers neither', () => {
    const closed = labels({ prs: [pr({ state: 'closed' })] });
    expect(closed.join(' ')).not.toContain('QA');
  });

  it('offers neither while a PR is still open', () => {
    expect(labels({ prs: [pr({ state: 'open' })] }).join(' ')).not.toContain('QA');
  });

  // Phase 18 amends the second half of this: a repo with no `qa.url` used to remove the button,
  // which is the live defect. The verb is still not RUNNABLE — it is drawn disabled instead.
  it('never RUNS on a repo with no qa.url, and says so instead of vanishing', () => {
    const actions = rowActions(itemActionFacts(item(), []), 'myWork');
    const verb = actions.find((a) => a.command === 'cgremlin.verifyInQa');
    expect(verb?.enabled).toBe(false);
    expect(actions.some((a) => a.command === 'cgremlin.askQa')).toBe(false);
  });

  it('offers neither on a parking-lot row, nor on an item with no ticket', () => {
    expect(labels({}, 'waitingForReview').length).toBeGreaterThan(0);
    expect(rowActions(facts(), 'parkingLot').map((a) => a.label).join(' ')).not.toContain('QA');
    expect(labels({ ticket: null }).join(' ')).not.toContain('QA');
  });

  it('withdraws both once a live QA agent exists, and Chat takes over', () => {
    const live = labels({ agents: [qaAgent()] });
    expect(live.join(' ')).not.toContain('Verify in QA');
    expect(live.join(' ')).not.toContain('Ask about QA');
    expect(live).toContain('Chat:primary');
  });

  // Phase 16 amends this: a closed session is still a verification that
  // happened, so the verb says `again` and leaves the one click to Chat.
  it('offers them again once the QA session is closed', () => {
    expect(labels({ agents: [qaAgent({ phase: 'closed', running: false })] }))
      .toContain('Verify in QA again:inline');
  });
});

describe('§8 — the QA part of the expanded row', () => {
  const partsOf = (over: Partial<WorkItem> = {}) => {
    const it_ = item(over);
    const f = itemActionFacts(it_, QA_REPOS);
    return itemParts({
      item: it_, list: 'myWork', slots: lifecycleSlots({ agents: it_.agents, facts: f, now: NOW }),
      actions: rowActions(f, 'myWork'), now: NOW, qaRepos: QA_REPOS,
    });
  };

  it('shows the verification state with Open and Chat', () => {
    const qa = partsOf({ agents: [qaAgent()] }).find((p) => p.kind === 'qa');
    expect(qa).toMatchObject({
      key: 'qa', name: 'QA verification', glyph: '⛋', state: 'running', stateText: 'verifying',
      childId: 'agent:qa-grace-frontend-HB-6210-20260915',
    });
    expect(qa?.actions.map((a) => a.label)).toEqual(['Read the QA result', 'Chat']);
  });

  it('says the verdict once it has one', () => {
    const qa = partsOf({ agents: [qaAgent({ phase: 'not_ready', running: false, needsYou: true })] })
      .find((p) => p.kind === 'qa');
    expect(qa?.stateText).toBe('not ready');
    expect(qa?.state).toBe('needsYou');
  });

  // Gap 1 — the QA part must not disagree with the collapsed row about a
  // blocked verdict; both read the same composer.
  it('says "blocked", not "not ready", when the verdict is blocked', () => {
    const qa = partsOf({
      agents: [qaAgent({ phase: 'not_ready', running: false, needsYou: true, qaVerdict: 'blocked' })],
    }).find((p) => p.kind === 'qa');
    expect(qa?.stateText).toBe('blocked');
  });

  it('exists un-run where the verbs do, and carries them', () => {
    const qa = partsOf().find((p) => p.kind === 'qa');
    expect(qa?.stateText).toBe('not started');
    expect(qa?.childId).toBeNull();
    expect(qa?.actions.map((a) => a.label)).toEqual(['Verify in QA', 'Ask about QA']);
  });

  it('is absent entirely where QA can never exist', () => {
    expect(partsOf({ prs: [pr({ state: 'open' })] }).some((p) => p.kind === 'qa')).toBe(false);
  });
});

describe('Gap 2 — an abandoned auto-verify attempt is visible', () => {
  it('renders a muted token on the collapsed row, and the manual action stays offered', () => {
    const withAttempt = item({ qaAttempt: { outcome: 'create-failed', at: '2026-09-15T09:00:00.000Z' } });
    const cells = meta(withAttempt);
    const token = cells.find((c) => c.kind === 'qaAttempt');
    expect(token).toBeDefined();
    expect(token?.tone).toBe('muted');

    const facts = itemActionFacts(withAttempt, QA_REPOS);
    expect(rowActions(facts, 'myWork').map((a) => a.label)).toContain('Verify in QA');
  });

  it('renders nothing with no qaAttempt at all (an engine that predates Gap 2, or a real session superseded the signal server-side)', () => {
    expect(meta(item()).some((c) => c.kind === 'qaAttempt')).toBe(false);
  });
});

describe('§5 — QA.md is labelled through the artifact-labels module', () => {
  it('names the role, and an archived version with it', () => {
    expect(artifactRole('QA.md')).toBe('qa');
    expect(artifactRole('QA-v2.md')).toBe('qa');
    expect(artifactLabel('QA.md')).toBe('QA verification');
  });

  it('is the primary answer, ahead of the review and the brief', () => {
    expect(primaryArtifactName(['BRIEF.md', 'REVIEW.md', 'QA.md'])).toBe('QA.md');
  });
});

/**
 * Phase 16 item 4 — manual re-verification, always available.
 *
 * Merging is not deploying, and a verdict is only ever a verdict about ONE
 * build. The user must be able to ask again — after a ✅ as much as after a ❌
 * — so the verbs are withdrawn only while a run is actually in flight, never
 * because a verdict exists. A second click re-runs the session it already has,
 * which archives the previous `QA.md` to `QA-v<n>.md`.
 */
describe('Phase 16 §4 — Verify in QA again', () => {
  const facts = (over: Partial<WorkItem> = {}) => itemActionFacts(item(over), QA_REPOS);
  const labels = (over: Partial<WorkItem> = {}, list: 'myWork' | 'waitingForReview' = 'myWork') =>
    rowActions(facts(over), list).map((a) => `${a.label}:${a.placement}`);

  it.each(['ready', 'not_ready', 'failed'])('offers a re-verify after a %s verdict', (phase) => {
    const done = labels({ agents: [qaAgent({ phase, running: false })] });
    expect(done).toContain('Verify in QA again:inline');
    expect(done).toContain('Ask about QA:inline');
    // The conversation keeps the one click: a re-verify is a deliberate ask.
    expect(done).toContain('Chat:primary');
  });

  it('still says "Verify in QA" where no verification has ever run', () => {
    expect(labels()).toContain('Verify in QA:primary');
    expect(labels().join(' ')).not.toContain('again');
  });

  it('withdraws it only while a run is in flight', () => {
    expect(labels({ agents: [qaAgent()] }).join(' ')).not.toContain('Verify in QA');
  });

  it('carries the re-verify in the expanded QA part, beside Open and Chat', () => {
    const it_ = item({ agents: [qaAgent({ phase: 'ready', running: false })] });
    const f = itemActionFacts(it_, QA_REPOS);
    const parts = itemParts({
      item: it_, list: 'myWork', slots: lifecycleSlots({ agents: it_.agents, facts: f, now: NOW }),
      actions: rowActions(f, 'myWork'), now: NOW, qaRepos: QA_REPOS,
    });
    const qa = parts.find((p) => p.kind === 'qa');
    expect(qa?.actions.map((a) => a.label)).toEqual([
      'Read the QA result', 'Chat', 'Verify in QA again', 'Ask about QA',
    ]);
  });
});

/**
 * Phase 16 item 5 — the row says which side of the deploy the change is on.
 *
 * The defect, in the user's words: "how do you know it? it is only when we cut
 * a new qa version." A merged change the QA build does not contain yet must
 * never read like a verification that passed.
 */
describe('Phase 16 §5 — merged, but not in QA yet', () => {
  const BUILD = '088ce5e07db734834e4948ad3365f4155cd1ae4e';

  it('reads "awaiting qa deploy", muted, on the collapsed row', () => {
    const cells = meta(item({ qaDeploy: { state: 'awaiting', sha: BUILD } }));
    const token = cells.find((c) => c.kind === 'qaDeploy');
    expect(token?.text).toBe('awaiting qa deploy');
    expect(token?.tone).toBe('muted');
  });

  it('names the build once a verification has run against it', () => {
    const cells = meta(
      item({
        qaDeploy: { state: 'verified', sha: BUILD },
        agents: [qaAgent({ phase: 'ready', running: false })],
      }),
    );
    expect(cells.find((c) => c.kind === 'agentPhase')?.text).toBe('⛋ QA ready to deploy');
    expect(cells.find((c) => c.kind === 'qaDeploy')?.text).toBe('build 088ce5e');
  });

  it('says nothing at all where QA names no build', () => {
    expect(meta(item()).some((c) => c.kind === 'qaDeploy')).toBe(false);
  });

  it('the expanded QA part says the same words, from the same composer', () => {
    const it_ = item({ qaDeploy: { state: 'awaiting', sha: BUILD } });
    const f = itemActionFacts(it_, QA_REPOS);
    const parts = itemParts({
      item: it_, list: 'myWork', slots: lifecycleSlots({ agents: it_.agents, facts: f, now: NOW }),
      actions: rowActions(f, 'myWork'), now: NOW, qaRepos: QA_REPOS,
    });
    expect(parts.find((p) => p.kind === 'qa')?.stateText).toBe('awaiting qa deploy');
  });
});

/**
 * Phase 18 item 1 — the QA verb is never hidden SILENTLY.
 *
 * The defect, in the user's words: "where should i see to start a qa review? i dont see that
 * anywhere." Every clause of §8's gate used to remove the button outright, so three of his four
 * QA-status tickets offered nothing at all and nothing said why. The gate is unchanged as a
 * PREDICATE — a click that would 404 is still refused — but a row that plausibly wants QA now
 * renders the verb DISABLED with one sentence the user can act on.
 */
describe('Phase 18 §1 — a blocked QA verb says why', () => {
  const QA_STATUSES = ['QA', 'UAT', 'Ready for QA'];
  const facts = (over: Partial<WorkItem> = {}, repos: readonly string[] = QA_REPOS) =>
    itemActionFacts(item(over), repos, QA_STATUSES);
  const qaAction = (over: Partial<WorkItem> = {}, repos: readonly string[] = QA_REPOS) =>
    rowActions(facts(over, repos), 'myWork').find((a) => a.command === 'cgremlin.verifyInQa');

  it('an item that fully qualifies still shows the enabled verb, exactly as today', () => {
    expect(qaAction()).toMatchObject({ label: 'Verify in QA', placement: 'primary' });
    expect(qaAction()?.enabled).not.toBe(false);
    expect(qaAction()?.reason).toBeUndefined();
  });

  it("names the exact config key when the PR's repo has no qa block", () => {
    const blocked = qaAction({}, []);
    expect(blocked?.enabled).toBe(false);
    expect(blocked?.reason).toBe(
      'This repo has no QA environment configured — add `environments["aplaceformom/grace-frontend"].qa.url` to core.json.',
    );
    // Never the row's one click: a button that does nothing must not take it.
    expect(blocked?.placement).toBe('inline');
  });

  it('says nothing is merged when the ticket sits in QA behind an unmerged PR', () => {
    expect(qaAction({ prs: [pr({ state: 'open' })] })?.reason).toBe(
      'Nothing is merged yet — QA verifies code that has landed.',
    );
    expect(qaAction({ prs: [pr({ state: 'closed' })] })?.reason).toBe(
      'Nothing is merged yet — QA verifies code that has landed.',
    );
  });

  it('says no PR is linked when the engine knows of none', () => {
    expect(qaAction({ prs: [] })?.reason).toBe('No pull request is linked to this ticket yet.');
  });

  it('says QA is unreachable when the last attempt could not reach it', () => {
    const unreachable = { outcome: 'unreachable' as const, at: '2026-09-15T09:00:00.000Z' };
    expect(qaAction({ qaAttempt: unreachable })?.reason).toBe('QA is unreachable right now.');
  });

  it('each reason appears for its own cause and never for another', () => {
    const reasons = [
      qaAction({}, [])?.reason,
      qaAction({ prs: [pr({ state: 'open' })] })?.reason,
      qaAction({ prs: [] })?.reason,
      qaAction({ qaAttempt: { outcome: 'unreachable', at: '2026-09-15T09:00:00.000Z' } })?.reason,
    ];
    expect(new Set(reasons).size).toBe(4);
    expect(reasons.every((r) => typeof r === 'string' && r !== '')).toBe(true);
  });

  it('offers the remedy beside the reason: a discovery, and the config file', () => {
    const noPr = rowActions(facts({ prs: [] }), 'myWork').map((a) => a.command);
    expect(noPr).toContain('cgremlin.discoverPrs');
    const noEnv = rowActions(facts({}, []), 'myWork').map((a) => a.command);
    expect(noEnv).toContain('cgremlin.openCoreConfig');
  });

  it('stays hidden where QA could never apply: no ticket, a parking-lot row, a live run', () => {
    expect(qaAction({ ticket: null })).toBeUndefined();
    expect(
      rowActions(facts(), 'parkingLot').some((a) => a.command === 'cgremlin.verifyInQa'),
    ).toBe(false);
    expect(qaAction({ agents: [qaAgent()] })).toBeUndefined();
  });

  it('stays hidden on a ticket that is not in a QA status and has nothing merged', () => {
    const away = itemActionFacts(
      item({ ticket: { ...item().ticket!, status: 'In Progress' }, prs: [pr({ state: 'open' })] }),
      QA_REPOS,
      QA_STATUSES,
    );
    expect(rowActions(away, 'myWork').some((a) => a.command === 'cgremlin.verifyInQa')).toBe(false);
  });

  it('carries the disabled verb and its reason into the QA part of the expanded row', () => {
    const it_ = item({ prs: [] });
    const f = itemActionFacts(it_, QA_REPOS, QA_STATUSES);
    const parts = itemParts({
      item: it_, list: 'myWork', slots: lifecycleSlots({ agents: it_.agents, facts: f, now: NOW }),
      actions: rowActions(f, 'myWork'), now: NOW, qaRepos: QA_REPOS, qaStatuses: QA_STATUSES,
    });
    const qa = parts.find((p) => p.kind === 'qa');
    const verb = qa?.actions.find((a) => a.command === 'cgremlin.verifyInQa');
    expect(verb?.enabled).toBe(false);
    expect(verb?.reason).toBe('No pull request is linked to this ticket yet.');
    expect(qa?.actions.map((a) => a.command)).toContain('cgremlin.discoverPrs');
  });
});
