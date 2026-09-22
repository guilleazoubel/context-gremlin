/**
 * Round 3 §e.1 and ruling 3 — what the expanded row fetches, and what it says with it.
 *
 * This drives the REAL wiring (`createUi` over a stub engine), because the point is the round
 * trip: the row the user expanded resolves its agent's `primaryArtifact`, reads it with
 * `CoreClient.artifactText`, and asks the engine's own inventory whether the PR has moved since
 * — all three bounded to the ONE row that was clicked.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { disposeHarnesses, panelHarness } from '../support/panel-harness';
import { fixtures, type StubHandler, type StubRequest } from '../support/stub-server';

afterEach(async () => {
  await disposeHarnesses();
});

const REVIEW = [
  '# Review',
  '',
  '**Verdict:** 🔄 Request changes — the payment retry loop can double-charge.',
  '',
  '### 1. Double charge on retry',
  '- **Severity:** 🔴 Critical',
].join('\n');

function handler(over: { artifact?: () => { status: number; text?: string } } = {}): StubHandler {
  return (req: StubRequest) => {
    if (req.method === 'GET' && /^\/sessions\/[^/]+\/artifacts\/[^/]+$/.test(req.path)) {
      return over.artifact?.() ?? { status: 200, text: REVIEW };
    }
    return undefined;
  };
}

async function expand(over: Parameters<typeof handler>[0] = {}) {
  const h = await panelHarness({ handler: handler(over) });
  h.toPanel({ type: 'toggleRow', id: 'pr:acme/web#102', expanded: true });
  await h.settle();
  return h;
}

describe('the expanded row carries the answer', () => {
  it('reads the review agent`s primary artifact and states its verdict and counts', async () => {
    const h = await expand();
    const row = h.rowOf('pr:acme/web#102');
    expect(row?.verdict?.label).toBe('Request changes');
    expect(row?.verdict?.sentence).toBe('the payment retry loop can double-charge.');
    expect(row?.verdict?.counts).toBe('1 critical');
    expect(row?.verdict?.tone).toBe('mixed');
  });

  it('asks for exactly the artifact the agent named, on the one row that was expanded', async () => {
    const h = await expand();
    const asked = h.server.requests.filter((req) => req.path.includes('/artifacts/'));
    expect(asked.map((req) => req.path)).toContain(
      '/sessions/pr-acme-web-102/artifacts/REVIEW.md',
    );
  });

  it('says the report could not be read, and keeps the rest of the block', async () => {
    const h = await expand({ artifact: () => ({ status: 500, text: 'boom' }) });
    const row = h.rowOf('pr:acme/web#102');
    expect(row?.verdict?.notice).toBe('The review could not be read');
    expect(row?.verdict?.label).toBe('');
    expect(row?.parts.length).toBeGreaterThan(0);
    expect(row?.facts.length).toBeGreaterThan(0);
  });

  it('says the PR changed after the agent looked at it, from the engine`s own newCommits', async () => {
    const h = await expand();
    expect(h.rowOf('pr:acme/web#102')?.verdict?.stale).toBe(
      'The pull request changed after the agent looked at it',
    );
  });

  it('says nothing of the kind where the inventory reports no new commits', async () => {
    const quiet = JSON.parse(JSON.stringify(fixtures.prs)) as {
      inventory: { entries: { ours: { newCommits?: boolean } }[] };
    };
    for (const entry of quiet.inventory.entries) {
      if (entry.ours.newCommits !== undefined) entry.ours.newCommits = false;
    }
    const h = await panelHarness({
      handler: (req) => {
        if (req.method === 'GET' && req.path === '/prs') return { status: 200, body: quiet };
        return handler()(req);
      },
    });
    h.toPanel({ type: 'toggleRow', id: 'pr:acme/web#102', expanded: true });
    await h.settle();
    expect(h.rowOf('pr:acme/web#102')?.verdict?.stale).toBeNull();
  });

  it('draws no block at all on a row whose agent wrote no parseable verdict', async () => {
    const h = await panelHarness({
      handler: (req) => {
        if (req.method === 'GET' && req.path === '/prs') {
          const quiet = JSON.parse(JSON.stringify(fixtures.prs)) as {
            inventory: { entries: { ours: { newCommits?: boolean } }[] };
          };
          for (const entry of quiet.inventory.entries) {
            if (entry.ours.newCommits !== undefined) entry.ours.newCommits = false;
          }
          return { status: 200, body: quiet };
        }
        return handler({ artifact: () => ({ status: 200, text: 'just prose' }) })(req);
      },
    });
    h.toPanel({ type: 'toggleRow', id: 'pr:acme/web#102', expanded: true });
    await h.settle();
    const row = h.rowOf('pr:acme/web#102');
    expect(row?.verdict).toBeNull();
    expect(JSON.stringify(row)).not.toContain('0 findings');
  });
});
