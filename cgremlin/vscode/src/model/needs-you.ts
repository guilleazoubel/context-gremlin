/**
 * P3 — the needs-you strip, and the badge that counts it.
 *
 * The news that something wants the user is worth having; arriving as a toast over whatever they
 * were typing into is not. So the same `attention.needsYou` the core already decided (R22) is
 * rendered in three quiet places instead: a strip at the top of the panel, a numeric badge on the
 * view container, and the count the status bar already carried. Nothing here re-derives who needs
 * whom — it words what the core said.
 *
 * Pure module — no editor API (MG-B1).
 */
import type { WorkItem, WorkItemAgent, WorkListKind } from './work-items';

export interface NeedsYouEntry {
  id: string;
  /** The list the strip clicks back into — an item is selected in a list, not in the abstract. */
  list: WorkListKind;
  label: string;
  /** The first reason, in the words a person would use. */
  reason: string;
}

/**
 * The core's vocabulary, said out loud. An unknown reason falls back to the raw token with its
 * underscores opened out, so a newer engine's reason reads as prose rather than as nothing.
 */
const REASON_TEXT: Record<string, string> = {
  plan_ready: 'plan ready',
  needs_input: 'needs input',
  blocked: 'blocked',
  run_failed: 'the run failed',
  review_ready: 'review ready',
  rereview_ready: 're-review ready',
  comments_ready: 'replies ready to post',
  local_prereq_failed: 'the local app would not start',
  changes_requested: 'changes requested',
  review_arrived: 'a review arrived',
  approved: 'approved',
};

export function reasonText(reason: string): string {
  return REASON_TEXT[reason] ?? reason.replace(/_/g, ' ');
}

/**
 * 0c — the engine's preflight refused to start a headless run and said why in `AGENT_NOTE`:
 * `Jira <KEY> could not be loaded (…) — fix access or choose Run anyway`, or
 * `GitHub is not usable: <detail>`. Those two prefixes are the contract; any other note is an
 * agent's own words and keeps today's wording.
 */
const PREFLIGHT_NOTE = /^(?:Jira|GitHub) /;

/** The one "Run anyway" sentence, said as ink beside the button (the webview has no tooltips). */
export const RUN_ANYWAY_HINT = 'Runs without the ticket; the brief will say so';

export interface PreflightBlock {
  sessionId: string;
  /** The engine's own line, verbatim — it is already written for a person. */
  note: string;
  /** The stage the blocked run was, which "Run anyway" re-issues; `null` where it cannot tell. */
  stage: string | null;
  /** Only a Jira block may be skipped, and only where the stage is known. GitHub never (R4). */
  runAnyway: boolean;
}

/**
 * Which stage the preflight blocked. The engine runs it before review, rereview, respond and
 * verify only; a review session sitting at a finished phase can only have been asked to re-review
 * (the start route restarts `queued`/`failed` as a review), so the phase decides between the two.
 */
function blockedStageOf(agent: WorkItemAgent): string | null {
  if (agent.mode === 'respond') return 'respond';
  if (agent.mode === 'qa') return 'verify';
  if (agent.mode !== 'review') return null;
  if (agent.phase === 'ready' || agent.phase === 'changes_requested') return 'rereview';
  if (agent.phase === 'queued' || agent.phase === 'failed') return 'review';
  return null;
}

/** The note an agent carries IF it is a preflight block; never for a running agent. */
export function preflightNoteOf(agent: {
  running: boolean;
  agentNote?: string | null;
}): string | null {
  const note = agent.agentNote ?? null;
  if (agent.running || note === null || !PREFLIGHT_NOTE.test(note)) return null;
  return note;
}

/**
 * The item's preflight block, or `null`. Only while the core says the item IS in `needs_input`:
 * a later run leaves the old note on disk (the runner rewrites AGENT_STATE alone), and a stale
 * note must never be shown as the reason.
 */
export function preflightBlockOf(item: WorkItem): PreflightBlock | null {
  if (!item.attention.reasons.includes('needs_input')) return null;
  for (const agent of [...item.agents].reverse()) {
    const note = preflightNoteOf(agent);
    if (note === null) continue;
    const stage = blockedStageOf(agent);
    return {
      sessionId: agent.sessionId,
      note,
      stage,
      runAnyway: note.startsWith('Jira ') && stage !== null,
    };
  }
  return null;
}

/**
 * One entry per item the core flagged, in the order the response carried them — which is the
 * order the lists themselves are in, so the strip reads top-down like the panel below it.
 */
export function needsYouEntries(items: readonly WorkItem[]): NeedsYouEntry[] {
  const entries: NeedsYouEntry[] = [];
  for (const item of items) {
    if (!item.needsYou) continue;
    const list = item.lists[0];
    if (list === undefined) continue;
    entries.push({
      id: item.id,
      list,
      label: item.title,
      reason: preflightBlockOf(item)?.note ?? reasonText(item.attention.reasons[0] ?? ''),
    });
  }
  return entries;
}

/** What the badge's hover says. Singular matters: the badge is read at a glance. */
export function badgeTooltip(count: number): string {
  return count === 1 ? '1 item needs you' : `${count} items need you`;
}
