/**
 * Phase 18 — a row whose run failed must offer a WAY FORWARD.
 *
 * The incident: an investigation's run died, every click answered "already has
 * a stage run in progress", and the row offered nothing but the error. The row
 * already says `run failed` on its needs-you strip; what it lacked was a verb.
 * Retry and Chat, both enabled, through the ONE rule table.
 */
import { describe, expect, it } from 'vitest';
import { rowActions, type ActionAgent, type ActionFacts } from '../../src/model/row-actions';
import { WORK_LIST_KINDS } from '../../src/model/work-items';

function facts(over: Partial<ActionFacts> = {}): ActionFacts {
  return { agents: [], prs: [], ticketKey: 'HB-1', needsYou: true, ...over };
}

const failedAgent: ActionAgent = {
  sessionId: 'inv-acme-app-HB-1-20260916-211103',
  mode: 'investigation',
  phase: 'findings',
  running: false,
  claimed: false,
  runFailed: true,
};

describe('a failed run always has a way out', () => {
  for (const list of WORK_LIST_KINDS) {
    it(`offers Retry and Chat, both enabled, on the ${list} list`, () => {
      const offered = rowActions(facts({ agents: [failedAgent] }), list);
      const retry = offered.find((a) => a.command === 'cgremlin.retry');
      const chat = offered.find((a) => a.command === 'cgremlin.chat');
      expect(retry, 'Retry').toBeDefined();
      expect(retry?.enabled).not.toBe(false);
      expect(retry?.childId).toBe(`agent:${failedAgent.sessionId}`);
      expect(chat, 'Chat').toBeDefined();
      expect(chat?.enabled).not.toBe(false);
    });
  }

  it('offers no Retry where no run has failed', () => {
    const healthy: ActionAgent = { ...failedAgent, runFailed: false };
    const offered = rowActions(facts({ agents: [healthy] }), 'myWork');
    expect(offered.map((a) => a.command)).not.toContain('cgremlin.retry');
  });

  it('never offers Retry for this window’s own optimism — a pending agent has no session', () => {
    const pending: ActionAgent = { ...failedAgent, sessionId: '', pending: true };
    const offered = rowActions(facts({ agents: [pending] }), 'myWork');
    expect(offered.map((a) => a.command)).not.toContain('cgremlin.retry');
  });
});
