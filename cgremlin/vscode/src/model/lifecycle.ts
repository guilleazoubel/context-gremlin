/**
 * The three lifecycle slots an expanded row shows: Investigation → Development → Review.
 *
 * The design amendment asks the expanded row to answer "where is this work?" in one glance, and
 * the answer is **always three slots**, even when two of them are empty. A slot that is missing
 * is information — "nothing has investigated this" — whereas a list of the agents that happen to
 * exist is a list whose shape changes per row and which therefore cannot be read at a glance.
 *
 * The forward-only rule (§4) is not re-derived here: `nextStages` in `row-actions` owns it, and
 * this module only marks which slot it named. One rule, one place — a slot that offered a Start
 * the row's own button refuses would be exactly the "button the user clicks returns an engine
 * error" that P0-2 is about.
 *
 * Pure module — no editor API (MG-B1).
 */
import { nextStages, STAGE_ORDER, type ActionFacts, type StageKind } from './row-actions';
import { compactAge } from './work-items';

export type SlotState = 'notStarted' | 'running' | 'needsYou' | 'done';

export interface LifecycleAgent {
  sessionId: string;
  mode: string;
  phase: string;
  running: boolean;
  needsYou: boolean;
  primaryArtifact: string | null;
  worktreePath?: string | null;
}

export interface LifecycleSlot {
  stage: StageKind;
  title: string;
  glyph: string;
  state: SlotState;
  /** What the slot says under its title: `not started`, `running · coding`, `done · 2h`. */
  stateText: string;
  /** The session behind the slot, `null` when the stage never ran. */
  sessionId: string | null;
  /** `true` when the forward-only ladder allows starting this stage now (§4). */
  next: boolean;
}

export interface LifecycleInput {
  agents: readonly LifecycleAgent[];
  /** What `nextStages` needs to say which stage may be started — the row's own facts. */
  facts: ActionFacts;
  /** The artifact mtimes the detail route carried, by session id. Absent is normal. */
  artifactAt?: Readonly<Record<string, string | null>>;
  now?: number;
}

const TITLES: Record<StageKind, string> = {
  investigation: 'Investigation',
  development: 'Development',
  review: 'Review',
};

/** Unicode, never an icon font — `font-src 'none'` would drop one silently (R38, R54). */
const GLYPHS: Record<StageKind, string> = {
  investigation: '∴',
  development: '◆',
  review: '◈',
};

export function lifecycleSlots(input: LifecycleInput): LifecycleSlot[] {
  const now = input.now ?? Date.now();
  const allowed = new Set<StageKind>(nextStages(input.facts));
  return STAGE_ORDER.map((stage) => {
    const agent = agentFor(input.agents, stage);
    const state = stateOf(agent);
    return {
      stage,
      title: TITLES[stage],
      glyph: GLYPHS[stage],
      state,
      stateText: stateTextOf(state, agent, input.artifactAt?.[agent?.sessionId ?? ''] ?? null, now),
      sessionId: agent?.sessionId ?? null,
      next: allowed.has(stage),
    };
  });
}

/**
 * The last agent of that mode. A stage re-run creates a second session and the *latest* one is
 * the state of the stage; the core already hands the agents back in its own order, so "last
 * wins" needs no timestamp of its own.
 */
function agentFor(
  agents: readonly LifecycleAgent[],
  stage: StageKind,
): LifecycleAgent | undefined {
  let found: LifecycleAgent | undefined;
  for (const agent of agents) if (agent.mode === stage) found = agent;
  return found;
}

function stateOf(agent: LifecycleAgent | undefined): SlotState {
  if (agent === undefined) return 'notStarted';
  if (agent.running) return 'running';
  if (agent.needsYou) return 'needsYou';
  return 'done';
}

/**
 * `done` carries the artifact's age when the engine told us one — "done" with no date is the
 * state the user said tells him nothing. No mtime is `done` alone, never a fabricated one
 * (MG-12), and a `running` slot says which phase rather than a date it does not have yet.
 */
function stateTextOf(
  state: SlotState,
  agent: LifecycleAgent | undefined,
  artifactAt: string | null,
  now: number,
): string {
  if (state === 'notStarted' || agent === undefined) return 'not started';
  if (state === 'running') return `running · ${agent.phase}`;
  if (state === 'needsYou') return `needs you · ${agent.phase}`;
  const age = artifactAt === null ? '—' : compactAge(artifactAt, now);
  return age === '—' ? 'done' : `done · ${age}`;
}

/**
 * Which of an item's sessions the row *is*, right now — the worktree a click swaps the workspace
 * to, and the session "changes so far" is counted in.
 *
 * A session without a worktree is not a candidate at all (there is nothing to open); among the
 * rest a running agent wins, because that is the one actually writing files. Otherwise the
 * furthest stage wins, `respond` included: answering a review is the most recent thing to have
 * happened on a PR even though it is not a stage of its own.
 */
export function currentAgentOf<T extends LifecycleAgent>(agents: readonly T[]): T | null {
  const withWorktree = agents.filter(
    (agent) => agent.worktreePath !== null && agent.worktreePath !== undefined && agent.worktreePath !== '',
  );
  if (withWorktree.length === 0) return null;
  const running = withWorktree.filter((agent) => agent.running);
  const pool = running.length > 0 ? running : withWorktree;
  let best = pool[0];
  for (const agent of pool) if (rankOf(agent.mode) >= rankOf(best.mode)) best = agent;
  return best;
}

/** `respond` ranks after `review`: it is what happens once a review has already landed. */
function rankOf(mode: string): number {
  return mode === 'respond' ? STAGE_ORDER.length : STAGE_ORDER.indexOf(mode as StageKind);
}

/**
 * Everything an open row's detail actually depends on, as one comparable string.
 *
 * The panel re-reads the open row's artifacts and its change counts on a refresh, and every SSE
 * frame schedules a refresh — so without this, a burst about somebody else's PR costs two engine
 * round trips per frame for a row that did not move. What the detail is built from is the agents
 * (which fill the slots), the PRs and the ticket (which fill the parts); a change anywhere else
 * on the item cannot alter it.
 *
 * The one thing it cannot see is an artifact being rewritten with no field changing, which is
 * why `artifact.changed` also invalidates by hand.
 */
export function detailSignatureOf(item: {
  agents: readonly LifecycleAgent[];
  prs: readonly { repo: string; number: number; updatedAt: string | null; reviewDecision: string | null; isDraft: boolean | null }[];
  ticket: { status: string; updatedAt: string } | null;
}): string {
  const agents = item.agents
    .map((a) => `${a.sessionId}|${a.mode}|${a.phase}|${a.running}|${a.needsYou}|${a.worktreePath ?? ''}`)
    .join(';');
  const prs = item.prs
    .map((p) => `${p.repo}#${p.number}|${p.updatedAt ?? ''}|${p.reviewDecision ?? ''}|${p.isDraft ?? ''}`)
    .join(';');
  const ticket = item.ticket === null ? '' : `${item.ticket.status}|${item.ticket.updatedAt}`;
  return `${agents}//${prs}//${ticket}`;
}
