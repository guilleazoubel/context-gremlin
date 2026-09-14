/**
 * The live case, through the REAL engine with a fake `gh`.
 *
 * `aplaceformom/grace#2180` merged 2026-09-11 ("feat(HB-1489): add
 * web-content read endpoint to the Grace backend"). It is not in
 * `gh pr list --state open`, and a respond session
 * (`respond-grace-2180-20260911-040030`, phase `addressing`) is still open on
 * it. Before this change the panel showed it under "My dev work" as live
 * work, with no state at all and no ticket.
 *
 * Everything below goes through `buildEngine` — the real InventoryScanner,
 * the real ReconciliationTick, the real pr-state leg and the real
 * WorkItemService — so the wiring is under test, not just the units.
 */
import { describe, expect, it } from 'vitest';
import { buildEngine, type EngineAdapters } from '../../src/host/build-engine';
import { resolveCoreConfig, type CoreConfig } from '../../src/config/core-config';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { FakeGitRunner } from '../support/fake-git-runner';
import { FakeAgentRunner } from '../support/fake-agent-runner';
import { FakeClock } from '../support/fake-clock';
import { GH_MUTATING_TOKENS } from '../support/fake-gh-runner';
import type { GhRunner } from '../../src/gh/gh-runner';
import type { JiraSource } from '../../src/jira/jira-source';
import type { Session } from '../../src/schema/session';

const REPO = 'aplaceformom/grace';
const TITLE = 'feat(HB-1489): add web-content read endpoint to the Grace backend';
const JIRA_ME = 'accountid-guilherme';
const RESPOND_ID = 'respond-grace-2180-20260911-040030';
const NOW = (): Date => new Date('2026-09-14T09:00:00.000Z');

const MUTATING = new Set<string>(GH_MUTATING_TOKENS);

/**
 * A routing fake rather than a queue: the engine makes several DIFFERENT gh
 * calls per scan (the open-PR list, a `pr view` per PR-bearing session, the
 * pr-state projection) and their order is an implementation detail this test
 * must not pin. Every call is asserted read-only on the way through.
 */
class RoutingGh implements GhRunner {
  readonly calls: string[][] = [];

  async run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    if (args.some((a) => MUTATING.has(a))) throw new Error(`mutating gh call: gh ${args.join(' ')}`);
    this.calls.push(args);
    // The open-PR list: #2180 merged, so it is simply not in it.
    if (args[0] === 'pr' && args[1] === 'list') return { stdout: '[]', stderr: '' };
    if (args[0] === 'api') return { stdout: '{}', stderr: '' };
    if (args[0] === 'pr' && args[1] === 'view') {
      const fields = args[args.indexOf('--json') + 1];
      // The pr-state projection (the leg) vs. PR_VIEW_FIELDS (reconciliation).
      return fields.includes('mergedAt') && !fields.includes('headRefOid')
        ? { stdout: JSON.stringify(this.stateView()), stderr: '' }
        : { stdout: JSON.stringify(this.fullView()), stderr: '' };
    }
    return { stdout: '', stderr: '' };
  }

  private stateView(): Record<string, unknown> {
    return {
      state: 'MERGED',
      mergedAt: '2026-09-11T13:34:00Z',
      closedAt: '2026-09-11T13:34:00Z',
      title: TITLE,
      url: `https://github.com/${REPO}/pull/2180`,
      headRefName: 'HB-1489-web-content-read',
    };
  }

  private fullView(): Record<string, unknown> {
    return {
      number: 2180,
      title: TITLE,
      author: { login: 'me-user' },
      headRefName: 'HB-1489-web-content-read',
      headRefOid: 'a'.repeat(40),
      baseRefName: 'main',
      url: `https://github.com/${REPO}/pull/2180`,
      state: 'MERGED',
      isDraft: false,
      reviewDecision: '',
      mergedAt: '2026-09-11T13:34:00Z',
      closedAt: '2026-09-11T13:34:00Z',
      latestReviews: [],
      statusCheckRollup: [],
    };
  }
}

function jiraSource(issues: unknown[]): JiraSource {
  return {
    search: async () => issues as never,
    issue: async () => {
      throw new Error('not used');
    },
    whoami: async () => ({ accountId: JIRA_ME, displayName: 'Guilherme' }),
  };
}

const HB_1489 = {
  key: 'HB-1489',
  summary: 'Web-content read endpoint',
  status: 'UAT',
  statusCategory: 'In Progress',
  assignee: JIRA_ME,
  updated: '2026-09-13T10:00:00.000Z',
  url: 'https://jira.invalid/browse/HB-1489',
};

function testConfig(): CoreConfig {
  return resolveCoreConfig(
    {
      repos: [REPO],
      me: 'me-user',
      watchAuthors: [],
      sessionsDir: '/sessions',
      worktreesDir: '/worktrees',
      mirrorsDir: '/mirrors',
      jira: {
        siteUrl: 'https://jira.invalid',
        email: 'me@example.invalid',
        apiToken: 'tok',
        jql: 'assignee = currentUser()',
        projectKeys: ['HB'],
      },
    },
    '/home/e2e',
  );
}

/** The stale respond session: standalone lineage, `addressing`, on the merged PR. */
function respondSession(stageStatus: 'addressing' | 'closed' = 'addressing'): Session {
  return {
    schemaVersion: 2,
    id: RESPOND_ID,
    mode: 'respond',
    createdAt: '2026-09-11T04:00:30.000Z',
    workspace: { repoUrl: `https://github.com/${REPO}.git`, worktreePath: `/worktrees/${RESPOND_ID}` },
    lineage: { pipelineId: RESPOND_ID, parentSessionId: null, ticket: 'HB-1489', selfReview: false },
    agent: null,
    lastRun: null,
    pr: {
      repo: REPO,
      number: 2180,
      url: `https://github.com/${REPO}/pull/2180`,
      headSha: 'a'.repeat(40),
      reviewedSha: null,
      title: TITLE,
      author: 'me-user',
    },
    stageStatus,
  };
}

async function engineWith(opts: { issues?: unknown[]; session?: Session | null } = {}) {
  const fs = new InMemoryFileSystem();
  const gh = new RoutingGh();
  const adapters: EngineAdapters = {
    fs,
    git: new FakeGitRunner(),
    gh,
    runner: new FakeAgentRunner(),
    runnerKind: 'claude-code',
    clock: new FakeClock(),
    now: NOW,
  };
  const engine = buildEngine(testConfig(), adapters, {
    jiraSource: jiraSource(opts.issues ?? [HB_1489]),
  });
  if (opts.session !== null) await engine.store.save(opts.session ?? respondSession());
  return { engine, gh, fs };
}

/** One full scan plus a drain of the background legs, then a second scan so the cache is in play. */
async function scanTwice(engine: Awaited<ReturnType<typeof engineWith>>['engine']): Promise<void> {
  await engine.scanner.run();
  await engine.scanner.stop();
  await engine.scanner.run();
  await engine.scanner.stop();
}

describe('the merged PR, through the real engine', () => {
  it("resolves state 'merged' for a session-referenced PR absent from the open list", async () => {
    const { engine } = await engineWith();
    await scanTwice(engine);

    const { items } = await engine.workItems.list();
    const item = items.find((i) => i.prs.some((p) => p.number === 2180));
    expect(item).toBeDefined();
    expect(item!.prs[0].state).toBe('merged');
  });

  it('closes the stale respond session, with the reason on the report', async () => {
    const { engine } = await engineWith();
    const first = await engine.scanner.run();

    expect(first.reconciliation.actions).toEqual([
      { type: 'transition', sessionId: RESPOND_ID, to: 'closed', reason: 'PR merged' },
    ]);
    expect((await engine.store.load(RESPOND_ID)).stageStatus).toBe('closed');
    await engine.scanner.stop();
  });

  it('keeps ONE item, `ticket:HB-1489`, carrying both the ticket and the merged PR', async () => {
    const { engine } = await engineWith();
    await scanTwice(engine);

    const { items, lists } = await engine.workItems.list();
    const item = items.find((i) => i.id === 'ticket:HB-1489');
    expect(item).toBeDefined();
    expect(item!.ticket?.key).toBe('HB-1489');
    expect(item!.ticket?.status).toBe('UAT');
    expect(item!.prs.map((p) => `${p.repo}#${p.number}`)).toEqual([`${REPO}#2180`]);
    // It stays in My dev work: the ticket is assigned to me and still in UAT.
    expect(lists.myWork).toContain('ticket:HB-1489');
    expect(lists.waitingForReview).not.toContain('ticket:HB-1489');
    // And there is no second, PR-shaped row for the same work.
    expect(items.filter((i) => i.prs.some((p) => p.number === 2180)).length).toBe(1);
  });

  it('the respond session is gone from the item once it closed — nothing says work in flight', async () => {
    const { engine } = await engineWith();
    await scanTwice(engine);

    const item = (await engine.workItems.list()).items.find((i) => i.id === 'ticket:HB-1489')!;
    expect(item.agents).toEqual([]);
  });

  it('an item whose ONLY reason to exist was the merged PR leaves every list', async () => {
    // No live ticket in the JQL, and the session has already been closed.
    const { engine } = await engineWith({ issues: [], session: respondSession('closed') });
    await scanTwice(engine);

    const { items, lists } = await engine.workItems.list();
    expect(items.filter((i) => i.prs.some((p) => p.number === 2180))).toEqual([]);
    for (const ids of [lists.myWork, lists.investigations, lists.waitingForReview]) {
      expect(ids).toEqual([]);
    }
    expect(lists.parkingLot).toEqual({ reviewing: [], untouched: [], someoneOnIt: [] });
  });

  it('spends at most one `gh pr view` on the pr-state projection, ever', async () => {
    const { engine, gh } = await engineWith();
    await scanTwice(engine);
    await scanTwice(engine);

    const stateCalls = gh.calls.filter(
      (c) => c[0] === 'pr' && c[1] === 'view' && (c[c.indexOf('--json') + 1] ?? '').includes('mergedAt') &&
        !(c[c.indexOf('--json') + 1] ?? '').includes('headRefOid'),
    );
    expect(stateCalls.length).toBe(1);
    expect(stateCalls[0]).toEqual([
      'pr', 'view', '2180', '--repo', REPO, '--json', 'state,mergedAt,closedAt,title,url,headRefName',
    ]);
  });

  it('writes the cache to <stateDir>/pr-states.json at 0600', async () => {
    const { engine, fs } = await engineWith();
    await scanTwice(engine);

    const path = '/home/e2e/.cgremlin-core/pr-states.json';
    expect(await fs.exists(path)).toBe(true);
    expect(await fs.statMode(path)).toBe(0o600);
    const cache = JSON.parse(await fs.readFile(path)) as Record<string, { state: string; ticketKeys: string[] }>;
    expect(cache[`${REPO}#2180`].state).toBe('merged');
    expect(cache[`${REPO}#2180`].ticketKeys).toEqual(['HB-1489']);
  });
});
