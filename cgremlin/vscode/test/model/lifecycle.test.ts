/**
 * The expanded row's three slots — always three, and never one that offers a Start the row's own
 * button would refuse.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  currentAgentOf,
  detailSignatureOf,
  lifecycleSlots,
  type LifecycleAgent,
} from '../../src/model/lifecycle';
import type { ActionFacts, ActionPr } from '../../src/model/row-actions';

const NOW = Date.parse('2026-09-11T12:00:00.000Z');

function agent(over: Partial<LifecycleAgent> & { mode: string }): LifecycleAgent {
  return {
    sessionId: `s-${over.mode}`,
    phase: 'working',
    running: false,
    needsYou: false,
    primaryArtifact: null,
    ...over,
  };
}

function pr(over: Partial<ActionPr> = {}): ActionPr {
  return { repo: 'acme/web', number: 1, isMine: true, isDraft: false, ...over };
}

function facts(over: Partial<ActionFacts> = {}): ActionFacts {
  return { agents: [], prs: [], ticketKey: null, needsYou: false, ...over };
}

const slots = (input: Parameters<typeof lifecycleSlots>[0]) =>
  lifecycleSlots({ now: NOW, ...input });

describe('the lifecycle slots', () => {
  it('are always the three stages, in order, even on a row where nothing ran', () => {
    const built = slots({ agents: [], facts: facts() });
    expect(built.map((slot) => slot.stage)).toEqual(['investigation', 'development', 'review']);
    expect(built.map((slot) => slot.stateText)).toEqual([
      'not started',
      'not started',
      'not started',
    ]);
    expect(built.map((slot) => slot.sessionId)).toEqual([null, null, null]);
  });

  it('reads a running agent as running, and names the phase', () => {
    const agents = [agent({ mode: 'development', phase: 'coding', running: true })];
    const built = slots({ agents, facts: facts({ agents: asActionAgents(agents) }) });
    expect(built[1].state).toBe('running');
    expect(built[1].stateText).toBe('running · coding');
    expect(built[1].sessionId).toBe('s-development');
  });

  /**
   * Round 3 §e.2 — a gate and a pipeline phase are two different axes, and joining them with a
   * `·` said they were one kind of thing. `needs you · ready` is what the user read as an answer
   * and it never was one; the answer is the verdict, which now has a block of its own. The phase
   * word survives only on `running`, where it is genuine progress.
   */
  it('reads the gate as "needs you", with no pipeline phase glued to it', () => {
    const agents = [agent({ mode: 'investigation', phase: 'plan_ready', needsYou: true })];
    const built = slots({ agents, facts: facts({ agents: asActionAgents(agents) }) });
    expect(built[0].state).toBe('needsYou');
    expect(built[0].stateText).toBe('needs you');
  });

  it('dates a finished slot by the artifact, and says plain "done" when it has no date', () => {
    const agents = [agent({ mode: 'investigation', phase: 'ready' })];
    const withDate = slots({
      agents,
      facts: facts({ agents: asActionAgents(agents) }),
      artifactAt: { 's-investigation': '2026-09-11T10:00:00.000Z' },
    });
    expect(withDate[0].stateText).toBe('done · 2h');

    const without = slots({ agents, facts: facts({ agents: asActionAgents(agents) }) });
    expect(without[0].stateText).toBe('done');
  });

  it('takes the latest agent of a stage that ran twice', () => {
    const agents = [
      agent({ mode: 'review', sessionId: 'old', phase: 'ready' }),
      agent({ mode: 'review', sessionId: 'new', phase: 'reviewing', running: true }),
    ];
    const built = slots({ agents, facts: facts({ agents: asActionAgents(agents) }) });
    expect(built[2].sessionId).toBe('new');
    expect(built[2].state).toBe('running');
  });
});

describe('the slot that may be started is the one the forward-only rule names (§4)', () => {
  it('offers both entry points when nothing has happened, and never review', () => {
    const built = slots({ agents: [], facts: facts() });
    expect(built.filter((slot) => slot.next).map((slot) => slot.stage)).toEqual([
      'investigation',
      'development',
    ]);
  });

  it('offers development once an investigation exists, and never investigation again', () => {
    const agents = [agent({ mode: 'investigation', phase: 'ready' })];
    const built = slots({ agents, facts: facts({ agents: asActionAgents(agents) }) });
    expect(built.filter((slot) => slot.next).map((slot) => slot.stage)).toEqual(['development']);
  });

  it('offers review once a PR exists, whether or not a development agent was ever seen', () => {
    const built = slots({ agents: [], facts: facts({ prs: [pr()] }) });
    expect(built.filter((slot) => slot.next).map((slot) => slot.stage)).toEqual(['review']);
  });

  it('offers nothing at all once a review has run — the ladder has no rung after it', () => {
    const agents = [agent({ mode: 'review', phase: 'ready' })];
    const built = slots({
      agents,
      facts: facts({ agents: asActionAgents(agents), prs: [pr()] }),
    });
    expect(built.filter((slot) => slot.next)).toEqual([]);
  });
});

function asActionAgents(agents: LifecycleAgent[]): ActionFacts['agents'] {
  return agents.map((a) => ({ ...a, claimed: false }));
}

describe('which session the row is, right now', () => {
  const withTree = (over: Partial<LifecycleAgent> & { mode: string }): LifecycleAgent =>
    agent({ worktreePath: `/wt/${over.sessionId ?? over.mode}`, ...over });

  it('is nothing when no session has a worktree to open', () => {
    expect(currentAgentOf([agent({ mode: 'development' })])).toBeNull();
    expect(currentAgentOf([])).toBeNull();
  });

  it('is the running session, even when a later stage exists but is idle', () => {
    const running = withTree({ mode: 'development', sessionId: 'dev', running: true });
    const idle = withTree({ mode: 'review', sessionId: 'rev' });
    expect(currentAgentOf([running, idle])?.sessionId).toBe('dev');
  });

  it('is the furthest stage when nothing is running, with respond ranking last', () => {
    const dev = withTree({ mode: 'development', sessionId: 'dev' });
    const review = withTree({ mode: 'review', sessionId: 'rev' });
    const respond = withTree({ mode: 'respond', sessionId: 'res' });
    expect(currentAgentOf([dev, review])?.sessionId).toBe('rev');
    expect(currentAgentOf([respond, dev, review])?.sessionId).toBe('res');
  });

  it('ignores a session that has no worktree, whatever its stage', () => {
    const dev = withTree({ mode: 'development', sessionId: 'dev' });
    const review = agent({ mode: 'review', sessionId: 'rev' });
    expect(currentAgentOf([dev, review])?.sessionId).toBe('dev');
  });
});

describe('what an open row’s detail depends on', () => {
  const item = (over: Partial<Parameters<typeof detailSignatureOf>[0]> = {}) => ({
    agents: [agent({ mode: 'development', phase: 'coding', running: true })],
    prs: [{ repo: 'acme/web', number: 1, updatedAt: 'T1', reviewDecision: '', isDraft: false }],
    ticket: { status: 'In Progress', updatedAt: 'T2' },
    ...over,
  });

  it('is the same string for the same agents, PRs and ticket', () => {
    expect(detailSignatureOf(item())).toBe(detailSignatureOf(item()));
  });

  it('changes when a phase, a run, a gate or a worktree does', () => {
    for (const over of [
      { phase: 'reviewing' },
      { running: false },
      { needsYou: true },
      { worktreePath: '/elsewhere' },
      { sessionId: 'other' },
    ]) {
      const moved = item({ agents: [agent({ mode: 'development', phase: 'coding', running: true, ...over })] });
      expect(detailSignatureOf(moved), JSON.stringify(over)).not.toBe(detailSignatureOf(item()));
    }
  });

  it('changes when a PR or the ticket moves on', () => {
    expect(
      detailSignatureOf(
        item({ prs: [{ repo: 'acme/web', number: 1, updatedAt: 'T9', reviewDecision: '', isDraft: false }] }),
      ),
    ).not.toBe(detailSignatureOf(item()));
    expect(detailSignatureOf(item({ ticket: { status: 'Done', updatedAt: 'T2' } }))).not.toBe(
      detailSignatureOf(item()),
    );
  });

  it('is blind to everything else on the item, which is the point', () => {
    expect(detailSignatureOf({ ...item(), needsYou: true } as never)).toBe(
      detailSignatureOf(item()),
    );
  });
});

/**
 * Round 3 AC 2 — "No string of the form `needs you · <phase>` appears anywhere". The unit test
 * above pins the one producer; this reads the sources, so a second producer cannot appear.
 */
describe('AC 2 — no module glues a gate to a pipeline phase', () => {
  const SRC = path.resolve(__dirname, '../../src');

  function sources(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sources(full);
      return entry.name.endsWith('.ts') ? [full] : [];
    });
  }

  it('has no `needs you · ` anywhere under src', () => {
    const offenders = sources(SRC).filter((file) =>
      fs.readFileSync(file, 'utf8').includes('needs you · '),
    );
    expect(offenders.map((file) => path.relative(SRC, file))).toEqual([]);
  });
});
