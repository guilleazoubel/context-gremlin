/**
 * Round 3 pre-merge — the block as a whole says ONE thing about ONE pull request.
 *
 * Driven through `PanelView` rather than the composer, because the defect was never in any one
 * function: three correct selections, made independently, produced a frame that was false.
 */
import { describe, expect, it } from 'vitest';
import { PanelView, type ExpandedDetail } from '../../src/ui/panel-view';
import { FakeHost, FakeWebviewView } from '../support/fake-host';
import { twoFinishedStages, twoPullRequests } from '../support/round3-items';
import type { ItemsResponse, WorkItem } from '../../src/model/work-items';
import type { PanelRowView, PanelState } from '../../src/model/panel-protocol';

const REVIEW = [
  '**Verdict:** ✅ Approve — nothing worth blocking on.',
  '',
  '### 1. A nit',
  '- **Severity:** 🎨 Design',
].join('\n');

async function open(item: WorkItem, detail?: Partial<ExpandedDetail>): Promise<PanelRowView> {
  const host = new FakeHost();
  const panel = new PanelView({
    host,
    assets: { scriptText: '', styleText: '' },
    mediaPath: '',
    onOpenItem: () => {},
    onOpenChild: () => {},
    onCommand: () => {},
    now: () => Date.parse('2026-09-22T12:00:00.000Z'),
    nonce: () => 'n',
    me: () => 'me',
    loadExpanded: async (which) =>
      ({
        artifactAt: {},
        changes: null,
        artifact: { mode: 'review', text: REVIEW, unreadable: false },
        newCommits: which.prs.find((p) => p.newCommits === true) !== undefined,
        ...detail,
      }) as ExpandedDetail,
  });
  const view = new FakeWebviewView();
  panel.resolveWebviewView(view);
  panel.setItems({
    evaluatedAt: '2026-09-22T12:00:00.000Z',
    lists: { parkingLot: { reviewing: [], untouched: [], someoneOnIt: [] }, myWork: [item.id], investigations: [], waitingForReview: [] },
    dismissed: [],
    items: [item],
    ticketSource: { kind: 'ok', message: null },
    threadSource: { kind: 'ok', message: null },
  } as unknown as ItemsResponse);
  panel.setConnected(true);
  view.webview.emit({ type: 'ready' });
  view.webview.emit({ type: 'toggleRow', id: item.id, expanded: true });
  // The detail is a round trip: the verdict block exists only once it has landed.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const state = [...view.webview.posted]
    .reverse()
    .find((m) => (m as { type?: string }).type === 'render') as { state: PanelState };
  const row = state.state.sections.flatMap((s) => s.rows).find((r) => r.id === item.id);
  if (row === undefined) throw new Error('no row');
  return row;
}

describe('the freshness bit and the facts belong to the verdict`s pull request', () => {
  it('describes the reviewed pull request, not the more recently updated one', async () => {
    const row = await open(twoPullRequests());
    expect(row.facts.join(' | ')).toContain('3 files +20/−4');
    expect(row.facts.join(' | ')).toContain('CI failing');
    expect(row.facts.join(' | ')).toContain("@dtorres's PR");
    // …and not one word about mine, which is `prs[0]`.
    expect(row.facts.join(' | ')).not.toContain('14 files');
  });

  it('says nothing about a pull request it cannot identify — neither facts nor freshness', async () => {
    const row = await open(twoPullRequests({ reviewedPrInList: false }), { newCommits: false });
    expect(row.facts).toEqual([]);
    expect(row.verdict?.stale ?? null).toBeNull();
    // The verdict itself still stands: it is the artifact's, and nothing about it was in doubt.
    expect(row.verdict?.label).toBe('Approve');
  });
});

describe('the prominent button opens the artifact the verdict quotes', () => {
  it('hoists the review, not the investigation that finished before it', async () => {
    const row = await open(twoFinishedStages());
    const primary = row.verbs.filter((verb) => verb.placement === 'primary');
    expect(primary.map((verb) => verb.label)).toEqual(['Read the review']);
    expect(primary[0].childId).toBe('agent:rev-1');
  });

  it('keeps the other report reachable rather than dropping it', async () => {
    const row = await open(twoFinishedStages());
    const everywhere = [
      ...row.verbs.map((verb) => verb.label),
      ...row.parts.flatMap((part) => part.actions.map((action) => action.label)),
    ];
    expect(everywhere).toContain('Read the findings');
  });

  it('still gives a failed run its Retry first — urgency outranks the quote', async () => {
    const item = twoFinishedStages();
    const failed = {
      ...item,
      agents: item.agents.map((a) => (a.mode === 'review' ? { ...a, runFailed: true } : a)),
    };
    const row = await open(failed);
    expect(row.verbs.filter((v) => v.placement === 'primary').map((v) => v.label)).toEqual(['Retry']);
  });
});
