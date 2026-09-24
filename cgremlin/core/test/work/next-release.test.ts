import { describe, expect, it } from 'vitest';
import { groupWorkItems, workListsOf, type GroupWorkItemsInput, type WorkItem } from '../../src/work/work-item';
import type { AttentionItem } from '../../src/attention/attention-service';
import { sessionRef } from '../../src/attention/item-ref';
import type { JiraScanReport } from '../../src/jira/jira-store';
import type { JiraIssueSummary } from '../../src/jira/jira-source';
import { CoreConfigSchema } from '../../src/config/core-config';
import type { SessionMode } from '../../src/schema/session';

/**
 * "My dev work" vs "Next release" — the split the user asked for: todo / in progress / in review
 * stay on my desk; waiting for QA, UAT and waiting for release have been HANDED ON.
 *
 * The fixtures are shaped like the user's live items: a UAT ticket with a merged PR and a qa
 * agent, an In Progress ticket, a To Do ticket, and a session with no ticket at all.
 */
const ME = 'me-user';
const REPO = 'acme/app';
const SEEN = '2026-09-04T00:00:00.000Z';
const JIRA_ME = '712020:me';

function agentAttention(o: { id: string; mode: SessionMode; ticket: string | null }): AttentionItem {
  return {
    source: 'session',
    ref: sessionRef(o.id),
    id: o.id,
    title: o.id,
    repoOrContext: REPO,
    attention: { needsAttention: false, needsYou: false, reasons: [], since: SEEN, signature: '', acked: false },
    links: {
      sessionId: o.id,
      worktreePath: `/wt/${o.id}`,
      prRepo: null,
      prNumber: null,
      prUrl: null,
      ticket: o.ticket,
      primaryArtifact: 'QA.md',
    },
    mode: o.mode,
    stageStatus: 'verifying',
    running: false,
    claimed: false,
  };
}

function jiraReport(issues: Partial<JiraIssueSummary>[]): JiraScanReport {
  return {
    scannedAt: SEEN,
    me: JIRA_ME,
    issues: issues.map((i) => ({
      key: 'HB-627',
      summary: 'a ticket',
      status: 'In Progress',
      statusCategory: 'indeterminate',
      assignee: JIRA_ME,
      assigneeName: null,
      updated: '2026-09-03T00:00:00.000Z',
      url: 'https://example.atlassian.net/browse/HB-627',
      ...i,
    })),
    error: null,
    kind: 'ok',
  };
}

/** The user's REAL default: nothing in their config sets either key, so zod's defaults apply. */
const defaults = CoreConfigSchema.parse({ me: ME, jira: { siteUrl: 'https://example.atlassian.net', email: 'me@example.com' } });

function group(over: Partial<GroupWorkItemsInput> = {}): WorkItem[] {
  return groupWorkItems({
    items: over.items ?? [],
    inventory: null,
    jira: over.jira ?? null,
    me: ME,
    watchAuthors: [],
    showAllRepoPrs: false,
    projectKeys: ['HB'],
    qaStatuses: over.qaStatuses ?? defaults.jira!.qaStatuses,
    releaseStatuses: over.releaseStatuses ?? defaults.jira!.releaseStatuses,
  });
}

const listsOf = (items: WorkItem[]): string[] => items[0]?.lists ?? [];

describe('the Next release section (core decides membership)', () => {
  it('puts a UAT ticket with a qa agent in nextRelease and NOT in myWork', () => {
    const items = group({
      items: [agentAttention({ id: 's-uat', mode: 'qa', ticket: 'HB-627' })],
      jira: jiraReport([{ key: 'HB-627', status: 'UAT' }]),
    });
    expect(listsOf(items)).toContain('nextRelease');
    expect(listsOf(items)).not.toContain('myWork');
  });

  it('keeps an In Progress ticket in myWork', () => {
    const items = group({
      items: [agentAttention({ id: 's-wip', mode: 'development', ticket: 'HB-627' })],
      jira: jiraReport([{ key: 'HB-627', status: 'In Progress' }]),
    });
    expect(listsOf(items)).toContain('myWork');
    expect(listsOf(items)).not.toContain('nextRelease');
  });

  it('keeps a To Do ticket in myWork', () => {
    const items = group({
      items: [agentAttention({ id: 's-todo', mode: 'development', ticket: 'HB-627' })],
      jira: jiraReport([{ key: 'HB-627', status: 'To Do' }]),
    });
    expect(listsOf(items)).toContain('myWork');
    expect(listsOf(items)).not.toContain('nextRelease');
  });

  it('leaves an item with NO ticket on my desk — nothing says it was handed on', () => {
    const items = group({ items: [agentAttention({ id: 's-none', mode: 'development', ticket: null })] });
    expect(listsOf(items)).toContain('myWork');
    expect(listsOf(items)).not.toContain('nextRelease');
  });

  it("is config-driven: the user's own default covers UAT, and a release status of its own", () => {
    expect(defaults.jira!.qaStatuses).toContain('UAT');
    expect(defaults.jira!.releaseStatuses.map((s) => s.toLowerCase())).toContain('waiting for release');
    // A site that names its stage differently gets there by config alone.
    const items = group({
      items: [agentAttention({ id: 's-site', mode: 'development', ticket: 'HB-627' })],
      jira: jiraReport([{ key: 'HB-627', status: 'Em homologação' }]),
      releaseStatuses: ['Em homologação'],
    });
    expect(listsOf(items)).toContain('nextRelease');
  });

  it('matches the status case-insensitively, and carries the id into workListsOf', () => {
    const items = group({
      items: [agentAttention({ id: 's-case', mode: 'development', ticket: 'HB-627' })],
      jira: jiraReport([{ key: 'HB-627', status: 'waiting for release' }]),
    });
    expect(workListsOf(items).nextRelease).toEqual(['ticket:HB-627']);
    expect(workListsOf(items).myWork).toEqual([]);
  });
});
