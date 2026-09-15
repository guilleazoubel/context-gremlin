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
    expect(qaStateText('ready')).toBe('ready');
    expect(qaStateText('not_ready')).toBe('not ready');
    // Gap 1 — a run failure (no verdict was ever reached) reads as its own
    // word now: 'blocked' is reserved for the QA VERDICT of the same name,
    // and conflating the two is exactly the ambiguity Gap 1 removes.
    expect(qaStateText('failed')).toBe('failed');
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

  it('a run failure stays "failed" no matter what verdict is passed', () => {
    expect(qaStateText('failed', 'blocked')).toBe('failed');
  });
});

describe('MG-27 — the collapsed row, through the ONE composer', () => {
  it('a landed myWork row mid-verification draws merged, the ticket status, then the QA cell', () => {
    const cells = meta(item({ agents: [qaAgent()] }));
    expect(cells.map((c) => c.kind)).toEqual([
      'repo', 'prState', 'ticketStatus', 'agentPhase', 'running', 'age', 'tier', 'size', 'ci',
    ]);
    expect(cells.map((c) => c.text).slice(0, 5)).toEqual([
      'grace-frontend', 'merged', 'UAT', '⛋ verifying', 'running',
    ]);
  });

  it('a not-ready verdict tones the phase cell bad, and it comes AFTER the ticket status', () => {
    const cells = meta(
      item({ agents: [qaAgent({ phase: 'not_ready', running: false, needsYou: true })], needsYou: true }),
    );
    const kinds = cells.map((c) => c.kind);
    expect(kinds.indexOf('ticketStatus')).toBeLessThan(kinds.indexOf('agentPhase'));
    const phase = cells.find((c) => c.kind === 'agentPhase');
    expect(phase).toEqual({ kind: 'agentPhase', text: '⛋ not ready', tone: 'bad' });
  });

  it('a ready verdict is quiet — the word is there, the tone is not', () => {
    const phase = meta(item({ agents: [qaAgent({ phase: 'ready', running: false })] }))
      .find((c) => c.kind === 'agentPhase');
    expect(phase).toEqual({ kind: 'agentPhase', text: '⛋ ready' });
  });

  // Gap 1 — a Blocked verdict (agent could not test) must not read as the
  // same word as a real not-ready verdict: they mean opposite things.
  it('a blocked verdict reads "blocked", distinctly from "not ready"', () => {
    const blocked = meta(
      item({ agents: [qaAgent({ phase: 'not_ready', running: false, needsYou: true, qaVerdict: 'blocked' })] }),
    ).find((c) => c.kind === 'agentPhase');
    expect(blocked).toEqual({ kind: 'agentPhase', text: '⛋ blocked', tone: 'bad' });

    const notReady = meta(
      item({ agents: [qaAgent({ phase: 'not_ready', running: false, needsYou: true, qaVerdict: 'not_ready' })] }),
    ).find((c) => c.kind === 'agentPhase');
    expect(notReady).toEqual({ kind: 'agentPhase', text: '⛋ not ready', tone: 'bad' });
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

  it('offers neither while a PR is still open, nor when the repo has no qa.url', () => {
    expect(labels({ prs: [pr({ state: 'open' })] }).join(' ')).not.toContain('QA');
    expect(
      rowActions(itemActionFacts(item(), []), 'myWork').map((a) => a.label).join(' '),
    ).not.toContain('QA');
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

  it('offers them again once the QA session is closed', () => {
    expect(labels({ agents: [qaAgent({ phase: 'closed', running: false })] }))
      .toContain('Verify in QA:primary');
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
    expect(qa?.actions.map((a) => a.label)).toEqual(['Open', 'Chat']);
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
