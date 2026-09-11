/**
 * Which actions a row may offer — ONE rule, shared by the panel and the Item tab (P0-2, §3.4).
 *
 * The defect this replaces: `actionsFor(item)` took no list at all and pushed `Start
 * investigation` and `Start development` on every row of every list, plus an unconditional `Ack`.
 * A parking-lot row is a *teammate's* PR: those two verbs can only ever produce a nonsensical
 * session, and the user said so. So the list is an argument, the rule table is here, and both
 * surfaces read it — the panel per list, the Item tab as the union over `item.lists`.
 *
 * Two rules shape the table:
 *  - **the hard list** (§1): no `Start development`/`Start investigation` on a parking-lot or a
 *    waiting-for-review row; no `Start investigation` anywhere a PR exists (R49); no second
 *    `Start review` where a review agent already is; no `Ack` where nothing needs you.
 *  - **forward only** (design amendment §4): the lifecycle is investigation → development →
 *    review, and only the stage *after* the furthest one reached is ever offered. A PR IS the
 *    development stage's output, so an item with a PR is already past it.
 *
 * Pure module — no editor API (MG-B1).
 */
import {
  agentChildId,
  chatTargetOfAgents,
  WORK_LIST_KINDS,
  type WorkItem,
  type WorkListKind,
} from './work-items';

export type StageKind = 'investigation' | 'development' | 'review';
export type StageReach = StageKind | 'none';

/** The lifecycle, in order. The index in this array IS the "how far along" comparison. */
export const STAGE_ORDER: readonly StageKind[] = ['investigation', 'development', 'review'];

/**
 * Where an action renders. Exactly one `primary` (the row's single click-to-act button); `inline`
 * is a visible button in the expanded area; `overflow` is the rarely-used `⋯` menu (R: Ack, and
 * the browser links).
 */
export type ActionPlacement = 'primary' | 'inline' | 'overflow';

export interface RowAction {
  command: string;
  label: string;
  /** Which part of the row the action is about, when the row has more than one (R26). */
  childId?: string;
  placement: ActionPlacement;
}

/** The subset of an agent the rule needs — so the Item tab's `TabAgent` satisfies it too. */
export interface ActionAgent {
  sessionId: string;
  mode: string;
  phase: string;
  running: boolean;
  claimed: boolean;
}

export interface ActionPr {
  repo: string;
  number: number;
  isMine: boolean | null;
  isDraft: boolean | null;
}

export interface ActionFacts {
  agents: readonly ActionAgent[];
  prs: readonly ActionPr[];
  ticketKey: string | null;
  needsYou: boolean;
}

export function itemActionFacts(item: WorkItem): ActionFacts {
  return {
    agents: item.agents,
    prs: item.prs,
    ticketKey: item.ticket?.key ?? null,
    needsYou: item.needsYou,
  };
}

/**
 * The furthest lifecycle stage this item has reached. A `respond` agent is NOT a stage of its
 * own: it answers a review that already happened. A PR counts as the development stage whether
 * or not the extension ever saw the agent that opened it (the work predates cgremlin, or the
 * session was pruned) — which is what stops "Start development" being offered on a PR.
 */
export function furthestStage(facts: ActionFacts): StageReach {
  let reach = -1;
  for (const agent of facts.agents) {
    const at = STAGE_ORDER.indexOf(agent.mode as StageKind);
    if (at > reach) reach = at;
  }
  if (facts.prs.length > 0 && reach < 1) reach = 1;
  return reach < 0 ? 'none' : STAGE_ORDER[reach];
}

/** Forward only: the stage after the furthest one reached, and never an earlier one. */
export function nextStages(facts: ActionFacts): StageKind[] {
  switch (furthestStage(facts)) {
    case 'none':
      // Nothing has happened yet, so both entry points are legitimate; the caller decides which
      // of the two is the primary.
      return ['investigation', 'development'];
    case 'investigation':
      return ['development'];
    case 'development':
      return ['review'];
    default:
      return [];
  }
}

/** The rule table (§3.4), for one row in one list. At most one action is flagged `primary`. */
export function rowActions(facts: ActionFacts, list: WorkListKind): RowAction[] {
  const out: RowAction[] = [];
  let primaryTaken = false;
  const push = (action: Omit<RowAction, 'placement'>, want: ActionPlacement): void => {
    const placement: ActionPlacement = want === 'primary' && primaryTaken ? 'inline' : want;
    if (placement === 'primary') primaryTaken = true;
    out.push({ ...action, placement });
  };

  const pr = facts.prs[0];
  const chat = chatTargetOfAgents(facts.agents);
  const chatAction =
    chat === null
      ? null
      : { command: 'cgremlin.chat', label: 'Chat', childId: agentChildId(chat) };

  if (list === 'parkingLot') {
    // A teammate's PR. Reviewing it is the only verb that belongs here at all.
    if (pr !== undefined && pr.isMine !== true && !facts.agents.some((a) => a.mode === 'review')) {
      push({ command: 'cgremlin.startReview', label: 'Start review' }, 'primary');
    }
    if (chatAction !== null) push(chatAction, 'inline');
  } else if (list === 'waitingForReview') {
    // My PR, out with reviewers. The only verbs are "answer the review" and, once the respond
    // agent has something to say, "talk to it" (R50) — never a second respond run on top of one.
    const respondable =
      pr !== undefined &&
      pr.isMine === true &&
      pr.isDraft === false &&
      !facts.agents.some((a) => a.mode === 'respond');
    if (respondable) {
      push({ command: 'cgremlin.addressReview', label: 'Address review comments' }, 'primary');
      if (chatAction !== null) push(chatAction, 'inline');
    } else if (chatAction !== null) {
      push(chatAction, 'primary');
    }
  } else {
    // My own work (`myWork`, `investigations`): the forward-only ladder.
    for (const stage of nextStages(facts)) {
      if (stage === 'investigation') {
        // R49: an investigation is the *no-PR* mode. Where a PR exists the question is settled.
        if (facts.prs.length > 0) continue;
        push({ command: 'cgremlin.startInvestigation', label: 'Start investigation' }, 'inline');
      } else if (stage === 'development') {
        push({ command: 'cgremlin.startDevelopment', label: 'Start development' }, 'primary');
      } else {
        push(
          {
            command: 'cgremlin.startReview',
            // My own PR: the core needs `selfReview`, and the wording says so rather than
            // pretending this is somebody else's change.
            label: pr?.isMine === true ? 'Start self-review' : 'Start review',
          },
          'primary',
        );
      }
    }
    if (chatAction !== null) push(chatAction, 'inline');
  }

  // The parts, always in the overflow: they are links, not decisions (R26).
  for (const part of facts.prs) {
    push(
      {
        command: 'cgremlin.openPr',
        label: `Open ${part.repo}#${part.number}`,
        childId: `pr:${part.repo}#${part.number}`,
      },
      'overflow',
    );
  }
  if (facts.ticketKey !== null) {
    push(
      {
        command: 'cgremlin.openTicket',
        label: `Open ${facts.ticketKey}`,
        childId: `ticket:${facts.ticketKey}`,
      },
      'overflow',
    );
  }
  if (facts.needsYou) push({ command: 'cgremlin.ack', label: 'Ack' }, 'overflow');

  if (!primaryTaken) promote(out);
  return out;
}

/**
 * A row with no verb of its own still gets one click that does something useful — the
 * conversation if there is one, else the PR, else the ticket. Never a verb that would 409.
 */
function promote(actions: RowAction[]): void {
  for (const command of ['cgremlin.chat', 'cgremlin.openPr', 'cgremlin.openTicket']) {
    const found = actions.find((action) => action.command === command);
    if (found !== undefined) {
      found.placement = 'primary';
      return;
    }
  }
}

/**
 * The Item tab is not scoped to a list, so it takes the **union** over the lists the item is in
 * (`ItemDetailResponse.item.lists`): an action is legitimate here when it is legitimate in at
 * least one context the item actually appears in. An item in no list offers nothing list-scoped
 * at all rather than guessing — the links and the ack survive, which is all a stray item needs.
 */
export function rowActionsForLists(
  facts: ActionFacts,
  lists: readonly WorkListKind[],
): RowAction[] {
  const seen = new Map<string, RowAction>();
  const ordered = WORK_LIST_KINDS.filter((kind) => lists.includes(kind));
  let primaryTaken = false;
  const add = (action: RowAction): void => {
    const key = `${action.command}:${action.childId ?? ''}`;
    const placement: ActionPlacement =
      action.placement === 'primary' && primaryTaken ? 'inline' : action.placement;
    const existing = seen.get(key);
    if (existing !== undefined) {
      if (rank(placement) > rank(existing.placement)) existing.placement = placement;
      else return;
    } else {
      seen.set(key, { ...action, placement });
    }
    if (placement === 'primary') primaryTaken = true;
  };
  for (const list of ordered) for (const action of rowActions(facts, list)) add(action);
  if (ordered.length === 0) {
    for (const action of listlessActions(facts)) add(action);
  }
  return [...seen.values()];
}

function rank(placement: ActionPlacement): number {
  return placement === 'primary' ? 2 : placement === 'inline' ? 1 : 0;
}

/** Everything in `rowActions` that is not a rule about a list: the links and the ack. */
function listlessActions(facts: ActionFacts): RowAction[] {
  return rowActions(facts, 'parkingLot').filter(
    (action) =>
      action.command === 'cgremlin.openPr' ||
      action.command === 'cgremlin.openTicket' ||
      action.command === 'cgremlin.ack',
  );
}
