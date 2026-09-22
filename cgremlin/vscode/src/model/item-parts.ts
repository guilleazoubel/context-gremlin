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
import {
  MODE_GLYPH, MODE_NAME, peopleLine, prLabel, prRefOf, qaDeployText, qaStateText,
} from './row-composition';
import type { LifecycleSlot } from './lifecycle';
import { chatTargetOfAgents, isLandedPr, prState, sizeOf, type WorkItem, type WorkListKind } from './work-items';
import {
  showsQa,
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
  /** Phase 18 — `jira.qaStatuses`, so a blocked QA part knows the item wants QA at all. */
  qaStatuses?: readonly string[];
  /** Round 3 §e.9 — the user's own login (`CoreConfigView.me`), so a line can leave him out. */
  me?: string;
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
    ticketStatus: item.ticket?.status ?? null,
    qaStatuses: input.qaStatuses ?? [],
    qaUnreachable: item.qaAttempt?.outcome === 'unreachable',
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
      actions: openAction(`ticket:${item.ticket.key}`, 'ticket').concat(
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
      detail: peopleLine(pr, input.me ?? ''),
      childId,
      actions: openAction(childId, 'pr').concat(
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
  // Phase 18 — the part exists wherever the gate has something to SAY, which now includes a
  // gate that fails: the reason belongs beside the verb it disabled, not nowhere.
  const startable = showsQa(facts, input.list);
  if (agent === undefined && !startable) return null;
  // Phase 16 — a change nobody has deployed yet has no verdict to report, and
  // the part says exactly what the collapsed row says (same composer).
  const awaiting = input.item.qaDeploy?.state === 'awaiting' ? input.item.qaDeploy : null;
  const childId = agent === undefined || agent.pending === true ? null : `agent:${agent.sessionId}`;
  const actions: RowAction[] = [];
  if (childId !== null) {
    actions.push(...openAction(childId, 'qa'));
    actions.push({ command: 'cgremlin.chat', label: 'Chat', childId, placement: 'inline' });
  }
  // Phase 16 — and the re-verification, wherever the row's own rule table
  // allows it: a verdict is about ONE build, so a finished verification is
  // never a reason to take the ask away (P0-2 still holds — no verb is
  // invented here, both are looked up in the actions the list allows).
  actions.push(...find(input.actions, 'cgremlin.verifyInQa', undefined, null));
  actions.push(...find(input.actions, 'cgremlin.askQa', undefined, null));
  // Phase 18 — and the remedy for whichever clause failed, where one exists.
  actions.push(...find(input.actions, 'cgremlin.discoverPrs', undefined, null));
  actions.push(...find(input.actions, 'cgremlin.openCoreConfig', undefined, null));
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
    actions.push(...openAction(childId, slot.stage));
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

/**
 * Round 3 §e.4 — the verb names the DOCUMENT, per the part's kind.
 *
 * Two buttons on one open row both read `Open`: the review's and the PR's. The word was
 * hardcoded here for every kind, so the row could not say which of them read what. A stage part
 * opens the artifact that stage wrote; a PR and a ticket have exactly one destination each and it
 * is GitHub or Jira, so neither keeps a local Open at all.
 */
const READ_LABEL: Partial<Record<PartKind, string>> = {
  investigation: 'Read the findings',
  development: 'Read the plan',
  review: 'Read the review',
  qa: 'Read the QA result',
};

function openAction(childId: string, kind: PartKind): RowAction[] {
  const label = READ_LABEL[kind];
  if (label === undefined) return [];
  return [{ command: 'cgremlin.openChild', label, childId, placement: 'primary' }];
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


/**
 * Round 3 §e.7 — the open block's verbs, with `ActionPlacement` finally READ.
 *
 * The field is computed through three modules (`rowActions` decides it, `rowActionsForLists`
 * merges it, `item-tab.ts` honours it) and the panel threw it away: every leftover action drew an
 * identical button, which is why `Ack`, `Rename` and `Dismiss` sat at the same weight as the verb
 * that does the work, and why two buttons could both read `Open`.
 *
 * The rule, once, here:
 *   - ONE primary — the recommended next action, full width. A failed run's `Retry` takes it over
 *     anything else, for the same reason `rowActions` pushes it first: it is the most urgent
 *     thing the row has to say.
 *   - At most TWO supporting verbs beside it. A third would be a button row again.
 *   - Everything else that is not a part's own verb goes to the disclosure as housekeeping.
 *
 * A verb that is hoisted LEAVES the part it came from, so nothing is said twice; a part's
 * remaining verbs stay under it, where a second `Chat` is unambiguous about which agent it means.
 * No verb is invented (P0-2): every one of these came out of `rowActions`.
 */
const SUPPORTING_LIMIT = 2;

/** Generic over the part shape, so the host may hand it either an `ItemPart` or its view. */
export function hoistVerbs<P extends { actions: RowAction[] }>(
  parts: readonly P[],
  actions: readonly RowAction[],
): { verbs: RowAction[]; parts: P[] } {
  const key = (action: RowAction): string => `${action.command}:${action.childId ?? ''}`;
  const pool: RowAction[] = [];
  const seen = new Set<string>();
  for (const action of [...parts.flatMap((part) => part.actions), ...actions]) {
    if (seen.has(key(action))) continue;
    seen.add(key(action));
    pool.push(action);
  }

  const retry = pool.find((action) => action.command === 'cgremlin.retry');
  const primary = retry ?? pool.find((action) => action.placement === 'primary') ?? null;
  const supporting = pool
    .filter((action) => action !== primary && action.placement !== 'overflow')
    .slice(0, SUPPORTING_LIMIT);
  const hoistedKeys = new Set([...(primary === null ? [] : [primary]), ...supporting].map(key));

  // The disclosure's own verbs: the row-level ones no part offers and nothing hoisted — which in
  // practice is the housekeeping, which is exactly where it belongs.
  const onParts = new Set(parts.flatMap((part) => part.actions.map(key)));
  const housekeeping = actions.filter(
    (action) => !hoistedKeys.has(key(action)) && !onParts.has(key(action)),
  );

  return {
    verbs: [
      ...(primary === null ? [] : [{ ...primary, placement: 'primary' as const }]),
      ...supporting.map((action) => ({ ...action, placement: 'inline' as const })),
      ...housekeeping.map((action) => ({ ...action, placement: 'overflow' as const })),
    ],
    parts: parts.map((part) => ({
      ...part,
      actions: part.actions.filter((action) => !hoistedKeys.has(key(action))),
    })),
  };
}
