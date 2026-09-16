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
import { prLabel, prRefOf } from './row-composition';
import {
  agentChildId,
  chatTargetOfAgents,
  isLandedPr,
  WORK_LIST_KINDS,
  type QaVerdict,
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
  /**
   * Phase 18 — absent means enabled. A verb whose gate fails is rendered DISABLED with a
   * `reason` rather than removed, because a button that silently is not there is the defect:
   * "where should i see to start a qa review? i dont see that anywhere."
   */
  enabled?: boolean;
  /** One sentence the user can act on. Shown as ink under the buttons, never as a tooltip. */
  reason?: string;
}

/** The subset of an agent the rule needs — so the Item tab's `TabAgent` satisfies it too. */
export interface ActionAgent {
  sessionId: string;
  mode: string;
  phase: string;
  running: boolean;
  claimed: boolean;
  /** Panel-local: a start in flight. It counts for "this stage has begun" and for nothing else. */
  pending?: boolean;
  /** Phase 18 — this session's last run failed, so the row owes the user a way forward. */
  runFailed?: boolean;
  /** Gap 1 — so `qaPart` can ask the ONE composer for the right word. */
  qaVerdict?: QaVerdict | null;
}

export interface ActionPr {
  repo: string;
  number: number;
  isMine: boolean | null;
  isDraft: boolean | null;
  /**
   * The PR's own state — the wire's `WorkItemPr.state`, or the display
   * wording the Item tab already carries (see `isLandedPr`). Optional, so an
   * engine older than the pr-state contract behaves exactly as it did.
   */
  state?: string | null;
}

/** Every PR on the item has merged or closed — the end of the forward-only ladder. */
function allLanded(facts: ActionFacts): boolean {
  return facts.prs.length > 0 && facts.prs.every((pr) => isLandedPr(pr));
}

export interface ActionFacts {
  agents: readonly ActionAgent[];
  prs: readonly ActionPr[];
  ticketKey: string | null;
  needsYou: boolean;
  /**
   * Phase 15 §8: the `owner/repo` slugs that have a `qa.url` in the engine's config, read from
   * `GET /config`. **Optional**: a panel that has not resolved the config yet, or an engine
   * older than Phase 15, offers no QA verb at all rather than one that would 404.
   */
  qaRepos?: readonly string[];
  /** The ticket's Jira status, compared against `qaStatuses` — "does this item WANT QA?". */
  ticketStatus?: string | null;
  /** `jira.qaStatuses` from `GET /config`. Absent means the panel cannot tell, so it stays quiet. */
  qaStatuses?: readonly string[];
  /** The last automatic attempt could not reach QA (`qaAttempt.outcome === 'unreachable'`). */
  qaUnreachable?: boolean;
}

export function itemActionFacts(
  item: WorkItem,
  qaRepos: readonly string[] = [],
  qaStatuses: readonly string[] = [],
): ActionFacts {
  return {
    agents: item.agents,
    prs: item.prs,
    ticketKey: item.ticket?.key ?? null,
    needsYou: item.needsYou,
    qaRepos,
    ticketStatus: item.ticket?.status ?? null,
    qaStatuses,
    qaUnreachable: item.qaAttempt?.outcome === 'unreachable',
  };
}

/** A QA session that has not reached one of R69's two terminal phases. */
export function liveQaAgent(facts: ActionFacts): ActionAgent | undefined {
  return facts.agents.find(
    (agent) => agent.mode === 'qa' && agent.phase !== 'closed' && agent.phase !== 'abandoned',
  );
}

/**
 * Phase 16 — a QA verification that is ACTUALLY RUNNING. The only reason to
 * withdraw the verbs: a second POST while the agent is mid-run would be
 * refused, and two agents must never write one QA.md. A finished
 * verification — whatever its verdict — is never a reason, because a verdict
 * is a verdict about ONE build and QA gets new ones.
 */
function runningQaAgent(facts: ActionFacts): ActionAgent | undefined {
  return facts.agents.find((agent) => agent.mode === 'qa' && agent.running);
}

/**
 * Phase 18 — the agent whose run died. A PENDING agent is excluded for the
 * reason `chatTargetOfAgents` excludes it: it has no session to act on yet.
 */
function failedAgent(facts: ActionFacts): ActionAgent | undefined {
  return facts.agents.find((agent) => agent.runFailed === true && agent.pending !== true);
}

/** Phase 16 — a verification has been run before, so the verb says `again`. */
export function qaVerbLabel(facts: ActionFacts): string {
  return facts.agents.some((agent) => agent.mode === 'qa') ? 'Verify in QA again' : 'Verify in QA';
}

/**
 * Phase 19 — the sentence a live run leaves in Chat's place. Said once, here, so the button and
 * whatever else renders a disabled reason (`aria-describedby`, `webview/panel/expanded.ts` and
 * `webview/item-tab.ts` both wire it off `enabled === false` generically) cannot drift apart.
 */
export const CHAT_BUSY_REASON = 'The agent is working on this now — chat opens when it finishes.';

/** Phase 18 — the four sentences, said in ONE place so a reason cannot drift from its cause. */
export const QA_NOTHING_MERGED_REASON = 'Nothing is merged yet — QA verifies code that has landed.';
export const QA_NO_PR_REASON = 'No pull request is linked to this ticket yet.';
export const QA_UNREACHABLE_REASON = 'QA is unreachable right now.';
export function qaNoEnvironmentReason(slug: string): string {
  return (
    'This repo has no QA environment configured — ' +
    `add \`environments["${slug}"].qa.url\` to core.json.`
  );
}

/**
 * Phase 18 — the remedy that belongs beside each reason. A sentence the user cannot act on is
 * half a fix, so the two reasons with an obvious next step carry one.
 */
export const QA_DISCOVER_COMMAND = 'cgremlin.discoverPrs';
export const QA_OPEN_CONFIG_COMMAND = 'cgremlin.openCoreConfig';

export type QaGate =
  /** The gate passes: the verbs are live, exactly as they were. */
  | { kind: 'ok' }
  /** QA can never apply to this row, so nothing is drawn — the only silence left. */
  | { kind: 'hidden' }
  /** The row plausibly wants QA and cannot have it: the verb is drawn DISABLED, with the why. */
  | { kind: 'blocked'; reason: string; remedy: Omit<RowAction, 'placement'> | null };

const HIDDEN: QaGate = { kind: 'hidden' };

/**
 * §8's gate, off the forward-only ladder entirely (R70) and asked in exactly one place.
 *
 * Every clause is a request the engine would otherwise refuse: `POST … {mode:'qa'}` needs a PR
 * (`server.ts` throws without one), needs a ticket to hang the session's lineage on, and needs a
 * repo whose `qa` block names a URL — nothing in the repo knows the QA address but the config.
 * `merged` is asked rather than `isLandedPr`: a change that was thrown away is not a change to
 * verify (E10), so a closed-only ticket offers nothing to run.
 *
 * Phase 18 amends what a FAILING clause does. It used to remove the button, which is the live
 * defect — three of the user's four QA tickets offered nothing and said nothing. So a row that
 * PLAUSIBLY WANTS QA (its ticket is in a configured `jira.qaStatuses`, or something of it has
 * merged) gets the verb disabled with one actionable sentence instead. A ticket that is in
 * neither position is still hidden: an item nobody has proposed for QA is not a QA failure.
 */
export function qaGate(facts: ActionFacts, list: WorkListKind): QaGate {
  if (list !== 'myWork' && list !== 'waitingForReview') return HIDDEN;
  // Every sentence below is about a ticket ("...linked to this ticket yet"), and the engine
  // needs one for the session's lineage, so an item without one has nothing to say.
  if (facts.ticketKey === null) return HIDDEN;
  const qaStatuses = facts.qaStatuses ?? [];
  const wantsQa =
    (facts.ticketStatus !== null &&
      facts.ticketStatus !== undefined &&
      qaStatuses.includes(facts.ticketStatus)) ||
    facts.prs.some((pr) => pr.state === 'merged');
  const blocked = (reason: string, remedy: Omit<RowAction, 'placement'> | null = null): QaGate =>
    wantsQa ? { kind: 'blocked', reason, remedy } : HIDDEN;

  if (facts.prs.length === 0) {
    // R84's case, and the user's normal one: teammates merge without a cgremlin session, so the
    // engine has never seen the PR. The remedy goes and looks for it.
    return blocked(QA_NO_PR_REASON, { command: QA_DISCOVER_COMMAND, label: 'Find merged PRs' });
  }
  if (!facts.prs.every((pr) => pr.state === 'merged')) return blocked(QA_NOTHING_MERGED_REASON);
  const qaRepos = facts.qaRepos ?? [];
  const missing = facts.prs.find((pr) => !qaRepos.includes(pr.repo));
  if (missing !== undefined) {
    return blocked(qaNoEnvironmentReason(missing.repo), {
      command: QA_OPEN_CONFIG_COMMAND,
      label: 'Open core.json',
    });
  }
  if (facts.qaUnreachable === true) return blocked(QA_UNREACHABLE_REASON);
  return { kind: 'ok' };
}

/** The predicate the rest of the panel asks, unchanged in meaning: may this item be verified? */
export function canVerifyInQa(facts: ActionFacts, list: WorkListKind): boolean {
  return qaGate(facts, list).kind === 'ok';
}

/** Phase 18 — is there anything to DRAW for QA here, live verb or disabled one? */
export function showsQa(facts: ActionFacts, list: WorkListKind): boolean {
  return qaGate(facts, list).kind !== 'hidden';
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

/**
 * Forward only: the stage after the furthest one reached, and never an earlier one.
 *
 * Merged and closed are TERMINAL in this table. A PR that has landed is not a
 * change waiting for a review; offering `Start review` on it was the live
 * defect (`aplaceformom/grace#2180`, merged, still offering to review itself).
 */
export function nextStages(facts: ActionFacts): StageKind[] {
  if (allLanded(facts)) return [];
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
  const chatAgent = chat === null ? undefined : facts.agents.find((a) => a.sessionId === chat);
  const chatAction =
    chat === null
      ? null
      : {
          command: 'cgremlin.chat',
          label: 'Chat',
          childId: agentChildId(chat),
          // Phase 19 — the escape hatch's opposite number. A run genuinely in flight used to
          // leave Chat clickable, and the click answered with the raw engine sentence `session
          // '…' already has a stage run in progress` ("I cant do anything"). The refusal was
          // correct; the silence was the bug, so the button says so itself and the sentence
          // never reaches the engine at all.
          ...(chatAgent?.running === true
            ? { enabled: false as const, reason: CHAT_BUSY_REASON }
            : {}),
        };

  // Phase 18 — the escape hatch, on every list. A run that died used to leave
  // the row with an error and no verb ("I can't do anything"); the engine now
  // heals the session, and this is the click that starts it over. Pushed
  // FIRST, so it takes the row's one primary wherever nothing else has: a
  // failed run is the most urgent thing the row has to say.
  const failed = failedAgent(facts);
  if (failed !== undefined) {
    push(
      { command: 'cgremlin.retry', label: 'Retry', childId: agentChildId(failed.sessionId) },
      'primary',
    );
  }

  if (list === 'parkingLot') {
    // A teammate's PR. Reviewing it is the only verb that belongs here at all.
    if (
      pr !== undefined &&
      pr.isMine !== true &&
      !isLandedPr(pr) &&
      !facts.agents.some((a) => a.mode === 'review')
    ) {
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
      // Nothing to address: the merge took every comment in with it.
      !isLandedPr(pr) &&
      !facts.agents.some((a) => a.mode === 'respond');
    if (respondable) {
      push({ command: 'cgremlin.addressReview', label: 'Address review comments' }, 'primary');
      if (chatAction !== null) push(chatAction, 'inline');
    } else {
      pushQa(facts, list, push);
      // `push` downgrades a second `primary` to `inline` on its own, so this stays the row's one
      // click wherever the QA verbs did not take it.
      if (chatAction !== null) push(chatAction, 'primary');
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
    pushQa(facts, list, push);
    if (chatAction !== null) push(chatAction, 'inline');
  }

  // The parts, always in the overflow: they are links, not decisions (R26).
  for (const part of facts.prs) {
    push(
      {
        command: 'cgremlin.openPr',
        label: `Open ${prLabel(part)}`,
        childId: prRefOf(part),
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
 * §8's two verbs, in the one place a verb is decided. They are withdrawn only while a QA run is
 * IN FLIGHT — never because a verdict exists (Phase 16): merging is not deploying, a verdict is
 * about one build, and QA gets new ones, so asking again must always be possible. Where a
 * verification has already happened the verb says `again` and takes the INLINE slot: the
 * conversation keeps the row's one click, and a re-verification is a deliberate ask.
 */
function pushQa(
  facts: ActionFacts,
  list: WorkListKind,
  push: (action: Omit<RowAction, 'placement'>, want: ActionPlacement) => void,
): void {
  // A run in flight is the ONE silence that stays: there is nothing to explain and nothing to
  // fix — the row is already showing the verification it would start.
  if (runningQaAgent(facts) !== undefined) return;
  const gate = qaGate(facts, list);
  if (gate.kind === 'hidden') return;
  if (gate.kind === 'blocked') {
    // Never `primary`: a disabled control must not be the row's one click. `Ask about QA` is
    // withdrawn with it — it POSTs the same session the engine would refuse.
    push(
      { command: 'cgremlin.verifyInQa', label: qaVerbLabel(facts), enabled: false, reason: gate.reason },
      'inline',
    );
    if (gate.remedy !== null) push(gate.remedy, 'inline');
    return;
  }
  const again = qaVerbLabel(facts) !== 'Verify in QA';
  push({ command: 'cgremlin.verifyInQa', label: qaVerbLabel(facts) }, again ? 'inline' : 'primary');
  // R73's chat-only entry: create the session, write its brief, start nothing.
  push({ command: 'cgremlin.askQa', label: 'Ask about QA' }, 'inline');
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
