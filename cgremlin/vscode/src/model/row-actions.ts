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
  type RunOutcome,
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
  /**
   * Task 2 — the engine's own `lastRun.outcome`, so the QA part can say `run failed` where the
   * run died rather than reporting the phase it died in as though it were a verdict.
   */
  runOutcome?: RunOutcome | null;
  /**
   * Phase 21 — the artifact the core would open this session on (`WorkItemAgent.primaryArtifact`).
   * The panel's only evidence that a stage produced its output, which is what tells a run that
   * failed EMPTY apart from a run that failed after writing what it was for.
   */
  primaryArtifact?: string | null;
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

/**
 * Phase 21 — the investigation whose plan is waiting on the human. `plan_ready` is the ONE stage
 * `PipelineService.approvePlan` accepts (it refuses every other with `UnsupportedStageError`), so
 * the button is offered exactly where the engine would say yes. A PENDING agent is excluded for
 * the reason `failedAgent` excludes it: it has no session to POST to yet.
 */
export function approvableInvestigation(facts: ActionFacts): ActionAgent | undefined {
  return facts.agents.find(
    (agent) =>
      agent.mode === 'investigation' && agent.phase === 'plan_ready' && agent.pending !== true,
  );
}

/**
 * Phase 21 — the investigation this item's development must continue FROM.
 *
 * `PipelineService.canPromote` accepts `approved`, or `plan_ready` only when the session was
 * created `driveToCompletion` — a flag the wire does not carry, so the panel cannot tell the
 * second case from the case the engine refuses. It offers the narrow one: `approved`, which is
 * always legal, and never a button that would come back with a `PlanGateError`.
 *
 * A RUNNING investigation is excluded because `promote` refuses one (its own stage run would be
 * in flight), and a pending one has no session to POST to.
 */
export function promotableInvestigation(facts: ActionFacts): ActionAgent | undefined {
  return facts.agents.find(
    (agent) =>
      agent.mode === 'investigation' &&
      agent.phase === 'approved' &&
      !agent.running &&
      agent.pending !== true,
  );
}

/**
 * Defect 3 — the verb, said once. It is the exact inverse of the claim `ChatSessions.open` takes.
 */
export const RELEASE_CONVERSATION_LABEL = 'Release the conversation';

/**
 * The session a human is holding the agent conversation on, if any. A PENDING agent is excluded
 * for the reason every other lookup here excludes it: it has no session to POST to yet.
 */
export function claimedAgent(facts: ActionFacts): ActionAgent | undefined {
  return facts.agents.find((agent) => agent.claimed && agent.pending !== true);
}

/** Any investigation on the item — the reason a development start must not be self-rooted. */
function anyInvestigation(facts: ActionFacts): ActionAgent | undefined {
  return facts.agents.find((agent) => agent.mode === 'investigation' && agent.pending !== true);
}

/**
 * Phase 21 — said once, beside the QA sentences, for the same reason they are: a disabled verb
 * without a sentence is the defect, and a sentence in two places drifts from its cause.
 */
export const DEVELOPMENT_NEEDS_APPROVAL_REASON =
  'Development continues from this investigation — approve its plan first.';

/**
 * Phase 21 — an investigation wedged behind a failed findings run that nevertheless WROTE its
 * findings. The live case: `stageStatus: 'findings'`, `lastRun.outcome: 'failed'`, a complete
 * 30 KB FINDINGS.md. The plan stage never chained, so the session can never reach `plan_ready`
 * and nothing in the approve/promote flow above can reach it. `Retry` re-runs the stage that
 * failed — the one whose output is already right — so it is the wrong first offer here.
 *
 * `primaryArtifact === 'FINDINGS.md'` is the evidence the file is there. It is not proof the file
 * is NON-EMPTY (the core ranks a listing, it does not read it): `runPlan` re-checks that under
 * the session's own lock and refuses with its own sentence, which is the refusal the user sees.
 */
export function resumableInvestigation(facts: ActionFacts): ActionAgent | undefined {
  return facts.agents.find(
    (agent) =>
      agent.mode === 'investigation' &&
      agent.phase === 'findings' &&
      agent.runFailed === true &&
      agent.primaryArtifact === 'FINDINGS.md' &&
      !agent.running &&
      agent.pending !== true,
  );
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
/**
 * Task 3 — the two sentences that used to be silence. A run in flight was returned on BEFORE the
 * gate was asked, so the row offered nothing and explained nothing; and merged work with no Jira
 * ticket answered `hidden`, which is the same silence as an item nobody proposed for QA.
 */
export const QA_RUNNING_REASON =
  'A verification is running now — it will report here when it finishes.';
export const QA_NO_TICKET_REASON =
  'A verification hangs off a Jira ticket, and no ticket is linked to this work yet.';
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
  const qaStatuses = facts.qaStatuses ?? [];
  const wantsQa =
    (facts.ticketStatus !== null &&
      facts.ticketStatus !== undefined &&
      qaStatuses.includes(facts.ticketStatus)) ||
    facts.prs.some((pr) => pr.state === 'merged');
  const blocked = (reason: string, remedy: Omit<RowAction, 'placement'> | null = null): QaGate =>
    wantsQa ? { kind: 'blocked', reason, remedy } : HIDDEN;

  // Task 3 — asked FIRST, and not through `blocked`: a verification that is running is proof
  // the item wants QA, whatever its ticket status or its repo config says.
  if (runningQaAgent(facts) !== undefined) {
    return { kind: 'blocked', reason: QA_RUNNING_REASON, remedy: null };
  }
  // The engine needs a ticket for the session's lineage. Merged work without one is the user's
  // dead end rather than an item QA does not apply to, so it gets the sentence, not the silence.
  if (facts.ticketKey === null) return blocked(QA_NO_TICKET_REASON);
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

  // Phase 19 — a way forward while the agent works: beside the disabled Chat, `Stop` targets the
  // very session that is running. Read off the same `chatAgent` Chat's own busy check already
  // found, so the two verbs can never disagree about which session is live.
  const stopAction =
    chatAgent?.running === true
      ? { command: 'cgremlin.stop', label: 'Stop', childId: agentChildId(chatAgent.sessionId) }
      : null;

  // Phase 18 — the escape hatch, on every list. A run that died used to leave
  // the row with an error and no verb ("I can't do anything"); the engine now
  // heals the session, and this is the click that starts it over. Pushed
  // FIRST, so it takes the row's one primary wherever nothing else has: a
  // failed run is the most urgent thing the row has to say.
  // Phase 21 — pushed BEFORE Retry, so it takes the row's one click. The stage that failed has
  // already produced what it was for; the stage that never ran is the way out.
  const resumable = resumableInvestigation(facts);
  if (resumable !== undefined) {
    push(
      {
        command: 'cgremlin.continueToPlan',
        label: 'Continue to plan',
        childId: agentChildId(resumable.sessionId),
      },
      'primary',
    );
  }

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
    if (stopAction !== null) push(stopAction, 'inline');
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
      if (stopAction !== null) push(stopAction, 'inline');
    } else {
      pushQa(facts, list, push);
      // `push` downgrades a second `primary` to `inline` on its own, so this stays the row's one
      // click wherever the QA verbs did not take it.
      if (chatAction !== null) push(chatAction, 'primary');
      if (stopAction !== null) push(stopAction, 'inline');
    }
  } else {
    // My own work (`myWork`, `investigations`): the forward-only ladder.
    //
    // Phase 21 — but FIRST the one decision that is the human's alone. An investigation that has
    // written an approved plan is waiting on a person to say the work is right, and that moment
    // outranks every verb below it: nothing further can legitimately happen until it is taken.
    // The wording is the decision, not the route (`POST /sessions/:id/approve-plan`).
    const approvable = approvableInvestigation(facts);
    if (approvable !== undefined) {
      push(
        {
          command: 'cgremlin.approvePlan',
          label: 'Approve the plan',
          childId: agentChildId(approvable.sessionId),
        },
        'primary',
      );
    }
    for (const stage of nextStages(facts)) {
      if (stage === 'investigation') {
        // R49: an investigation is the *no-PR* mode. Where a PR exists the question is settled.
        if (facts.prs.length > 0) continue;
        push({ command: 'cgremlin.startInvestigation', label: 'Start investigation' }, 'inline');
      } else if (stage === 'development') {
        // Phase 21 — the wording is the same verb; the ROUTE is the whole bug. An item with an
        // investigation behind it must reach development through `POST /sessions/:id/promote`,
        // which creates the CHILD session (`lineage.parentSessionId`, FINDINGS.md and PLAN.md
        // carried across). `cgremlin.startDevelopment` is a fresh, self-rooted session, so where
        // an investigation exists it is never the right route — not even while that investigation
        // is unfinished, which is why the unapproved case is DISABLED rather than swapped back.
        const investigation = anyInvestigation(facts);
        if (investigation === undefined) {
          push({ command: 'cgremlin.startDevelopment', label: 'Start development' }, 'primary');
        } else {
          const ready = promotableInvestigation(facts);
          push(
            {
              command: 'cgremlin.promoteToDevelopment',
              label: 'Start development',
              childId: agentChildId((ready ?? investigation).sessionId),
              ...(ready === undefined
                ? { enabled: false as const, reason: DEVELOPMENT_NEEDS_APPROVAL_REASON }
                : {}),
            },
            // A disabled control must never be the row's one click (the QA gate's rule).
            ready === undefined ? 'inline' : 'primary',
          );
        }
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
    if (stopAction !== null) push(stopAction, 'inline');
  }

  // Defect 3 — the way to give the conversation BACK, on every list, wherever somebody is
  // holding one. Taking the claim is invisible (opening Chat does it), holding it refuses every
  // stage, and until now nothing in the extension called
  // `POST /sessions/:id/conversation/release` at all — the user was told to release it and given
  // no way to. Never `primary`: it is an undo, not the work.
  const held = claimedAgent(facts);
  if (held !== undefined) {
    push(
      {
        command: 'cgremlin.releaseConversation',
        label: RELEASE_CONVERSATION_LABEL,
        childId: agentChildId(held.sessionId),
      },
      'inline',
    );
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
  // Round 3 — the verb names its EFFECT rather than the jargon. It clears the item from the
  // needs-you count, which is the one thing reading it does not do, so it stays reachable.
  if (facts.needsYou) push({ command: 'cgremlin.ack', label: 'Mark as seen' }, 'overflow');

  if (!primaryTaken) promoteFallbackPrimary(out);
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
  // Task 3 — a run in flight is no longer a silence: `qaGate` answers it with a sentence, and
  // the disabled verb is what tells the user the ask was heard and is being worked on.
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
function promoteFallbackPrimary(actions: RowAction[]): void {
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
