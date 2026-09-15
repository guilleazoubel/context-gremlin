/**
 * §4 — what a row opens into: ONE list of the item's own parts.
 *
 * The defect this replaces is the user's "options that don't apply". The expanded row rendered
 * all three lifecycle slots on every row, so a teammate's parking-lot PR offered `Investigation /
 * not started` and `Development / not started` — two stages whose Start could only ever produce a
 * nonsensical session on somebody else's branch. The rule that forbids them already existed
 * (`nextStages`); only the view ignored it.
 *
 * So the parts are derived, in a fixed order — investigation, development, review, ticket, then
 * one per PR — and each is shown only where §4's table says it means something. **No verb is
 * invented here**: every button is looked up in the `RowAction`s the list already allows, which is
 * what makes "no button produces an engine error" a property rather than a hope.
 *
 * Pure module — no editor API (MG-B1).
 */
import { MODE_GLYPH, MODE_NAME, prLabel, prRefOf, qaDeployText, qaStateText } from './row-composition';
import type { LifecycleSlot } from './lifecycle';
import { chatTargetOfAgents, isLandedPr, prState, sizeOf, type WorkItem, type WorkListKind } from './work-items';
import {
  canVerifyInQa,
  liveQaAgent,
  nextStages,
  type ActionAgent,
  type ActionFacts,
  type RowAction,
  type StageKind,
} from './row-actions';

export type PartKind = StageKind | 'qa' | 'ticket' | 'pr';

export interface ItemPart {
  /** `investigation` | `development` | `review` | `ticket:<KEY>` | `pr:<repo>#<n>` (§8). */
  key: string;
  kind: PartKind;
  name: string;
  glyph: string;
  /** The lifecycle state, for the stylesheet. Empty for a ticket or a PR. */
  state: string;
  stateText: string;
  /** A second line, where the part has one: who has been on the PR. */
  detail: string;
  /** What `openChild` addresses, or `null` for a stage that never ran. */
  childId: string | null;
  actions: RowAction[];
}

/**
 * Geometric marks, never emoji: emoji size inconsistently in a sidebar, take a colour the theme
 * does not control, and become a box wherever the emoji font is missing — and `font-src 'none'`
 * (R38) means the panel cannot ship one. A hollow diamond is a PR, a filled one is work of mine,
 * a nested one is a review of it, and a therefore-sign is a conclusion.
 */
const STAGE_GLYPHS: Record<StageKind, string> = {
  investigation: '∴',
  development: '◆',
  review: '◈',
};

const START_COMMAND: Record<StageKind, string> = {
  investigation: 'cgremlin.startInvestigation',
  development: 'cgremlin.startDevelopment',
  review: 'cgremlin.startReview',
};

export interface ItemPartsInput {
  item: WorkItem;
  list: WorkListKind;
  /** §8's gate needs the repos that have a `qa.url`; absent means no QA part and no QA verb. */
  qaRepos?: readonly string[];
  /** Already built by `lifecycleSlots`, so the state wording is said in exactly one place. */
  slots: readonly LifecycleSlot[];
  /** The list's own rule table — the only source of a verb (P0-2). */
  actions: readonly RowAction[];
  now?: number;
}

export function itemParts(input: ItemPartsInput): ItemPart[] {
  const { item, list } = input;
  const facts: ActionFacts = {
    agents: item.agents,
    prs: item.prs,
    ticketKey: item.ticket?.key ?? null,
    needsYou: item.needsYou,
    qaRepos: input.qaRepos ?? [],
  };
  const allowed = new Set(nextStages(facts));
  const parts: ItemPart[] = [];

  for (const slot of input.slots) {
    if (!showsStage(slot.stage, item, list, allowed, slot.sessionId !== null, input.actions)) {
      continue;
    }
    parts.push(stagePart(slot, input));
  }

  const qa = qaPart(facts, input);
  if (qa !== null) parts.push(qa);

  if (item.ticket !== null) {
    parts.push({
      key: `ticket:${item.ticket.key}`,
      kind: 'ticket',
      name: item.ticket.key,
      glyph: '▣',
      state: '',
      stateText: item.ticket.status,
      detail: '',
      childId: `ticket:${item.ticket.key}`,
      actions: openAction(`ticket:${item.ticket.key}`).concat(
        find(input.actions, 'cgremlin.openTicket', `ticket:${item.ticket.key}`, 'Open in Jira'),
      ),
    });
  }

  for (const pr of item.prs) {
    const childId = prRefOf(pr);
    parts.push({
      key: childId,
      kind: 'pr',
      name: prLabel(pr),
      glyph: '◇',
      // The one PR state the stylesheet cares about: a landed PR is muted,
      // because the row is still here for its ticket, not for the change.
      state: isLandedPr(pr) ? prState(pr) : '',
      stateText: prStateText(pr, input.now),
      detail: peopleLine(pr),
      childId,
      actions: openAction(childId).concat(
        find(input.actions, 'cgremlin.openPr', childId, 'Open on GitHub'),
      ),
    });
  }
  return parts;
}

/**
 * Phase 15 §8 — the verification, as a part of the item like any other.
 *
 * It is NOT a lifecycle slot: QA sits off the forward-only ladder (R70), so it is neither
 * derived from `nextStages` nor drawn where the three stages are. It exists on exactly the rows
 * where a verification can exist — a live QA session, or a gate that would light the verbs —
 * and it never invents a verb of its own: `Open`/`Chat` for a session that exists, and
 * otherwise whichever of §8's two the row's own rule table already allows (P0-2).
 *
 * The state word comes from the ONE composer (`qaStateText`), so this part and the collapsed
 * row's cell cannot drift apart.
 */
function qaPart(facts: ActionFacts, input: ItemPartsInput): ItemPart | null {
  const agent = liveQaAgent(facts) ?? lastQaAgent(facts);
  const startable = canVerifyInQa(facts, input.list);
  if (agent === undefined && !startable) return null;
  // Phase 16 — a change nobody has deployed yet has no verdict to report, and
  // the part says exactly what the collapsed row says (same composer).
  const awaiting = input.item.qaDeploy?.state === 'awaiting' ? input.item.qaDeploy : null;
  const childId = agent === undefined || agent.pending === true ? null : `agent:${agent.sessionId}`;
  const actions: RowAction[] = [];
  if (childId !== null) {
    actions.push(...openAction(childId));
    actions.push({ command: 'cgremlin.chat', label: 'Chat', childId, placement: 'inline' });
  }
  // Phase 16 — and the re-verification, wherever the row's own rule table
  // allows it: a verdict is about ONE build, so a finished verification is
  // never a reason to take the ask away (P0-2 still holds — no verb is
  // invented here, both are looked up in the actions the list allows).
  actions.push(...find(input.actions, 'cgremlin.verifyInQa', undefined, null));
  actions.push(...find(input.actions, 'cgremlin.askQa', undefined, null));
  return {
    key: 'qa',
    kind: 'qa',
    name: MODE_NAME.qa,
    glyph: MODE_GLYPH.qa,
    state: agent === undefined ? 'notStarted' : qaSlotState(agent),
    stateText:
      agent === undefined
        ? (awaiting === null ? 'not started' : qaDeployText(awaiting))
        : qaStateText(agent.phase, agent.qaVerdict ?? null),
    detail: '',
    childId,
    actions,
  };
}

/** A finished verification still says what it found, which is the whole point of the row. */
function lastQaAgent(facts: ActionFacts): ActionAgent | undefined {
  let found: ActionAgent | undefined;
  for (const agent of facts.agents) if (agent.mode === 'qa') found = agent;
  return found;
}

/** The same three words the lifecycle slots use, so one stylesheet rule covers both. */
function qaSlotState(agent: ActionAgent): string {
  if (agent.running) return 'running';
  return agent.phase === 'not_ready' || agent.phase === 'failed' ? 'needsYou' : 'done';
}

/** §4's table, as one predicate per stage. `ran` is "an agent of this mode exists". */
function showsStage(
  stage: StageKind,
  item: WorkItem,
  list: WorkListKind,
  allowed: ReadonlySet<StageKind>,
  ran: boolean,
  actions: readonly RowAction[],
): boolean {
  const mine = list === 'myWork' || list === 'investigations';
  if (stage === 'investigation') {
    // R49: an investigation is the no-PR mode. Where a PR exists and none ever ran, the question
    // is settled and the part would only ever say "not started" at a stage nobody can enter.
    if (list === 'parkingLot' || list === 'waitingForReview') return false;
    if (item.prs.length > 0 && !ran) return false;
    return ran || (mine && allowed.has('investigation'));
  }
  if (stage === 'development') {
    if (list === 'parkingLot') return false;
    if (list === 'waitingForReview') return ran;
    return ran || (mine && allowed.has('development'));
  }
  if (list === 'parkingLot') return true;
  if (list === 'investigations') return false;
  if (list === 'waitingForReview') {
    // My PR, out with reviewers: the Review part is where "answer the review" lives, so it is
    // drawn exactly where that verb — or the agent that already answered — exists (§4).
    return (
      ran ||
      item.agents.some((a) => a.mode === 'respond') ||
      actions.some((action) => action.command === 'cgremlin.addressReview')
    );
  }
  return ran || allowed.has('review');
}

function stagePart(slot: LifecycleSlot, input: ItemPartsInput): ItemPart {
  const agent = input.item.agents.filter((candidate) => candidate.sessionId === slot.sessionId)[0];
  const childId = slot.sessionId === null ? null : `agent:${slot.sessionId}`;
  const actions: RowAction[] = [];
  if (childId !== null) {
    actions.push(...openAction(childId));
    // R50's gate, asked of the one function every surface asks: a respond agent still writing its
    // brief has nothing to say yet, so it offers no Chat.
    if (agent !== undefined && chatTargetOfAgents([agent]) !== null) {
      actions.push({ command: 'cgremlin.chat', label: 'Chat', childId, placement: 'inline' });
    }
  }
  // The Start comes from the row's own actions or not at all — a slot that offered a verb the row
  // refuses is exactly the engine error P0-2 is about.
  if (slot.next) {
    actions.push(...find(input.actions, START_COMMAND[slot.stage], undefined, null));
  }
  // The one verb that is not a Start and not a Chat: answering a review that has landed (§4).
  if (slot.stage === 'review' && input.list === 'waitingForReview') {
    actions.push(...find(input.actions, 'cgremlin.addressReview', undefined, null));
  }
  return {
    key: slot.stage,
    kind: slot.stage,
    name: slot.title,
    glyph: STAGE_GLYPHS[slot.stage],
    state: slot.state,
    stateText: slot.stateText,
    detail: '',
    childId,
    actions,
  };
}

function openAction(childId: string): RowAction[] {
  return [{ command: 'cgremlin.openChild', label: 'Open', childId, placement: 'inline' }];
}

/**
 * The row's own action for this command, re-labelled where the part says it shorter. Absent means
 * the list does not allow it, and the button is simply not there.
 */
function find(
  actions: readonly RowAction[],
  command: string,
  childId: string | undefined,
  label: string | null,
): RowAction[] {
  const found = actions.find(
    (action) => action.command === command && (childId === undefined || action.childId === childId),
  );
  if (found === undefined) return [];
  return [{ ...found, label: label ?? found.label, placement: 'inline' }];
}

/** `open · 43 files +900/−12 · CI failing · Opened 12 Aug` (§4). */
function prStateText(pr: WorkItem['prs'][number], now: number | undefined): string {
  void now;
  const parts = [prState(pr), sizeOf(pr)];
  if (pr.ci === 'failure') parts.push('CI failing');
  else if (pr.ci === 'pending') parts.push('CI pending');
  const opened = openedOn(pr.createdAt);
  if (opened !== '') parts.push(opened);
  return parts.filter((part) => part !== '—').join(' · ');
}

/** `Opened 12 Aug`, or nothing at all where the engine sent no date (MG-12). */
function openedOn(createdAt: string | null): string {
  if (createdAt === null) return '';
  const at = Date.parse(createdAt);
  if (Number.isNaN(at)) return '';
  return `Opened ${new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
}

/** Who has already been on the PR — the evidence `people` used to carry on its own block. */
function peopleLine(pr: WorkItem['prs'][number]): string {
  const reviewed = (pr.humanActivity?.reviewedBy ?? []).map((login) => `@${login} reviewed`);
  const commented = (pr.humanActivity?.commentedBy ?? []).map((login) => `@${login} commented`);
  return [...reviewed, ...commented].join(', ');
}
