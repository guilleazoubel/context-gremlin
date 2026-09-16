/**
 * Phase 18 — a failed run must be visible to the PANEL's action rule, not only
 * to the needs-you strip. The wedge left the user with an error and no escape;
 * the way out is Retry, and the row cannot offer it unless the wire says which
 * agent failed.
 */
import { describe, expect, it } from 'vitest';
import { groupWorkItems, type GroupWorkItemsInput } from '../../src/work/work-item';
import type { AttentionItem } from '../../src/attention/attention-service';
import { sessionRef } from '../../src/attention/item-ref';

const ID = 'inv-acme-app-HB-1-20260916-211103';

function investigationAgent(reasons: string[]): AttentionItem {
  return {
    source: 'session',
    ref: sessionRef(ID),
    id: ID,
    title: 'the findings run that died',
    repoOrContext: 'acme/app',
    attention: {
      reasons,
      since: '2026-09-16T21:11:06.000Z',
      needsAttention: reasons.length > 0,
      needsYou: reasons.length > 0,
      acked: false,
    },
    links: {
      sessionId: ID,
      worktreePath: `/worktrees/${ID}`,
      prRepo: null,
      prNumber: null,
      prUrl: null,
      ticket: 'HB-1',
      primaryArtifact: null,
    },
    mode: 'investigation',
    stageStatus: 'findings',
    running: false,
    claimed: false,
  } as unknown as AttentionItem;
}

function input(items: AttentionItem[]): GroupWorkItemsInput {
  return {
    items,
    inventory: null,
    jira: null,
    me: 'me-user',
    watchAuthors: [],
    showAllRepoPrs: false,
    projectKeys: ['HB'],
  } as unknown as GroupWorkItemsInput;
}

describe('the wire says which agent failed', () => {
  it('a `run_failed` session becomes an agent the panel can offer a way out of', () => {
    const [item] = groupWorkItems(input([investigationAgent(['run_failed'])]));
    expect(item?.agents[0]?.runFailed).toBe(true);
  });

  it('a session with nothing wrong carries no failure', () => {
    const [item] = groupWorkItems(input([investigationAgent([])]));
    expect(item?.agents[0]?.runFailed).toBe(false);
  });
});
