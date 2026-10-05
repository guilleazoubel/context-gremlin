/**
 * Every contributed command, and the creation flows.
 *
 * Three rules shape this file:
 *  - the engine's own wording for a refusal is shown verbatim (`engineErrorText`) — its 4xx
 *    messages are written for humans, and paraphrasing them loses the instruction they carry;
 *  - a request that the API would reject for a reason the widget could have caught is never sent:
 *    the ticket input and the PR-URL input validate with mirrors of the core's own rules;
 *  - **every item-addressed call goes through `/items/<path>`** (R14/R65): the path is built by
 *    `itemPathOf` from the item's id, never interpolated by hand, and a *child* click uses that
 *    child's own path — a PR child of a `ticket:` item opens `/items/pr/o/r/n`.
 */
import { prLabel, prRefOf } from '../model/row-composition';
import { engineErrorText, type CoreClient, type HttpResult } from '../core-client';
import { refreshBlockedMessage } from '../model/engine-trouble';
import { RELEASE_CONVERSATION_LABEL } from '../model/row-actions';
import { readTitle, writeTitle } from '../model/item-title';
import { preflightBlockOf } from '../model/needs-you';
import { withEngineRetry, type EngineRevival } from './engine-retry';
import {
  agentOfChildId,
  chatTargetOf,
  descriptionOf,
  itemPathOf,
  type ItemFocus,
  type WorkItem,
} from '../model/work-items';
import type { EngineHealthSource } from './engine';
import type { DisposableLike, Host } from './host';
import type { ItemTab } from './item-tab';
import type { PanelView } from './panel-view';
import type { WorktreeSwapper } from './preview';
import type { ChatSessions } from './terminal';
import type { RefreshCoordinator } from './refresh';

/** `src/api/validation.ts:54` — the ticket feeds a session id, so it must be one path segment. */
const TICKET = /^[A-Za-z0-9._-]+$/;

/** Empty means "no ticket"; anything else must satisfy the API's own regex. */
export function validateTicket(value: string): string | null {
  if (value === '') return null;
  return TICKET.test(value)
    ? null
    : 'A ticket may contain only letters, digits, dot, underscore and dash.';
}

/** A mirror of `parsePrUrl` (`src/gh/pr-url.ts:18-38`): host github.com, /<owner>/<repo>/pull/<n>. */
const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/;

export function validatePrUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'Enter a full GitHub pull request URL.';
  }
  if (parsed.host !== 'github.com') return 'Only github.com pull request URLs are supported.';
  if (!PR_PATH.test(parsed.pathname)) {
    return 'Expected a path like /<owner>/<repo>/pull/<number>.';
  }
  return null;
}

const INTENTS = ['Investigate only', 'Development-bound'] as const;
const DRIVE = ['Stop at the plan', 'Drive to completion'] as const;

/**
 * Phase 19 — `Stop`'s modal confirm. The row's rule table (`row-actions.ts`) offers the verb only
 * beside a busy, disabled Chat, so by the time this asks the user has already been told an agent
 * is on it; the modal names what the click actually does, in words a person weighing whether to
 * interrupt a running agent can act on.
 */
/**
 * Defect 3 — the two halves of a refusal that used to be a dead end.
 *
 * `HumanTurnInProgressError` (core `pipeline-service.ts`) is the ONE refusal whose remedy the
 * user cannot reach from anywhere: releasing the claim is a route, not a button, and the sentence
 * named it without offering it. Matched on the engine's own wording rather than on a status code,
 * because 409 is also a live run, a plan gate and an own-PR review — none of which a release would
 * help. The refusal itself is untouched: a claim somebody is holding still refuses.
 */
const CLAIM_REFUSAL = /holds the (?:agent )?conversation/i;

export const STOP_RUN_CONFIRM_TEXT =
  "This ends the agent's current run. Work it already wrote to files is kept.";
export const STOP_RUN_CONFIRM_LABEL = 'Stop the run';

/**
 * The approval is the human's, always — an agent may never post one (`core/src/gh/pr-approval.ts`
 * and the post helper that refuses the event). So this verb asks, in the user's own words, before
 * anything reaches GitHub: a click is consent, and it has to be a click that was meant.
 */
export const APPROVE_PR_CONFIRM_TEXT =
  'This posts YOUR approval on this pull request, under your GitHub account. An approval counts toward branch protection and can let the pull request merge.';
export const APPROVE_PR_CONFIRM_LABEL = 'Post my approval';

export interface CommandDeps {
  host: Host;
  client: CoreClient;
  coordinator: RefreshCoordinator;
  panel: PanelView;
  itemTab: ItemTab;
  chat: ChatSessions;
  /** P10: the worktree swap, for the one command that opens the managed workspace outright. */
  swapper?: WorktreeSwapper;
  /**
   * The engine's own surface, when there is one. Refresh consults it first: a scan sent to a
   * socket with no usable engine on it fails invisibly, and the panel simply stays as it was.
   */
  engine?: EngineHealthSource;
  /**
   * Phase 18 — where `core.json` is, so the `Open core.json` remedy can open the very file the
   * reason names. Absent makes that command say so rather than guess at a path.
   */
  configPath?: () => string;
}

/**
 * Phase 18 — which LINE of `core.json` a missing `environments["<slug>"].qa.url` goes on, 1-based.
 *
 * Deliberately textual: the file is the user's, comments and formatting and all, and re-parsing
 * it to find a position would throw away exactly the layout the caret is supposed to land in.
 * The repo's own line first, then the `environments` block, then nothing — an `undefined` opens
 * the file at the top, which is still better than not opening it.
 */
export function configLineFor(text: string, slug: string | null): number | undefined {
  const lines = text.split('\n');
  const block = lines.findIndex((line) => line.includes('"environments"'));
  if (block === -1) return undefined;
  if (slug !== null) {
    // Only BELOW the block: every slug is also in `repos`, and landing the caret there would
    // point at the one place a `qa` block must not go.
    const at = lines.findIndex((line, index) => index > block && line.includes(`"${slug}"`));
    if (at !== -1) return at + 1;
  }
  return block + 1;
}

export function registerCommands(deps: CommandDeps): DisposableLike[] {
  const { host, client, coordinator, panel, chat } = deps;

  /** `cgremlin.refreshInventory`'s single in-flight probe, so a burst of clicks shares one probe
   *  and produces one message rather than one of each per click. */
  let refreshInFlight: Promise<void> | null = null;

  const idOf = (arg: unknown): string | null => (typeof arg === 'string' && arg !== '' ? arg : null);

  const itemOf = (arg: unknown): WorkItem | null => {
    const id = idOf(arg);
    if (id === null) return null;
    return panel.itemOf(id) ?? coordinator.itemOf(id) ?? null;
  };

  const needsItem = (arg: unknown): WorkItem | null => {
    const item = itemOf(arg);
    if (item === null) {
      void host.showWarningMessage('Pick an item in the cgremlin panel first.', undefined);
    }
    return item;
  };

  /**
   * One engine request from a user command: sent, and — when the socket has gone — sent again
   * after a user-triggered start (`ui/engine-retry`). `null` means both attempts failed, and the
   * sentence has already been shown.
   */
  const send = (work: () => Promise<HttpResult>): Promise<HttpResult | null> => sendTo(deps, work);

  const surface = (result: HttpResult | null): boolean => {
    if (result === null) return false;
    if (result.status >= 200 && result.status < 300) return true;
    void host.showWarningMessage(engineErrorText(result.body), undefined);
    return false;
  };

  /**
   * `surface`, for a call addressed at ONE session — the only calls a held claim can refuse.
   *
   * A refusal the user cannot act on is half a fix (the Phase 18 rule, applied to the one refusal
   * that had no remedy at all). So the engine's sentence arrives with the button that clears it,
   * and taking the offer re-sends the very verb that was refused: the user asked once.
   */
  const surfaceSession = async (
    result: HttpResult | null,
    id: string,
    call: (id: string) => Promise<HttpResult>,
  ): Promise<boolean> => {
    if (result === null) return false;
    if (result.status >= 200 && result.status < 300) return true;
    const text = engineErrorText(result.body);
    if (!CLAIM_REFUSAL.test(text)) {
      void host.showWarningMessage(text, undefined);
      return false;
    }
    const answer = await host.showWarningMessage(text, undefined, RELEASE_CONVERSATION_LABEL);
    if (answer !== RELEASE_CONVERSATION_LABEL) return false;
    if (!surface(await send(() => client.releaseConversation(id)))) return false;
    return surface(await send(() => call(id)));
  };

  /** The session a per-session command acts on: the selected agent, else the item's first. */
  const sessionOf = (item: WorkItem): string | null => {
    const current = coordinator.currentSession();
    if (current !== null && item.agents.some((agent) => agent.sessionId === current)) return current;
    return item.agents[0]?.sessionId ?? null;
  };

  const onSession = async (
    arg: unknown,
    call: (id: string) => Promise<HttpResult>,
  ): Promise<void> => {
    const item = needsItem(arg);
    if (item === null) return;
    const id = sessionOf(item);
    if (id === null) {
      void host.showWarningMessage('That item has no session to act on.', undefined);
      return;
    }
    if (await surfaceSession(await send(() => call(id)), id, call)) coordinator.schedule();
  };

  /**
   * Phase 21 — `onSession`, but for a verb the rule table addressed at ONE named session
   * (`childId: 'agent:<id>'`). Falls back to the item's chat target so a caller without a child id
   * behaves exactly as it did.
   */
  const onNamedSession = async (
    arg: unknown,
    childArg: unknown,
    call: (id: string) => Promise<HttpResult>,
  ): Promise<void> => {
    const item = needsItem(arg);
    if (item === null) return;
    const id = agentOfChildId(idOf(childArg)) ?? sessionOf(item);
    if (id === null) {
      void host.showWarningMessage('That item has no session to act on.', undefined);
      return;
    }
    if (await surfaceSession(await send(() => call(id)), id, call)) coordinator.schedule();
  };

  /**
   * §8's two verbs address the item through its MERGED PR's own path — `pr:<slug>#<n>` is the
   * key the API route locks on and the key the automatic leg reserves under (E2/E9). A row with
   * no PR cannot reach QA at all (the core refuses it), and says so rather than sending a call
   * it knows would 400.
   */
  const qaPathOf = (arg: unknown): string | null => {
    const item = needsItem(arg);
    if (item === null) return null;
    const pr = item.prs[0];
    if (pr === undefined) {
      void host.showWarningMessage(
        `'${item.title}' has no merged pull request to verify in QA.`,
        undefined,
      );
      return null;
    }
    return itemPathOf(prRefOf(pr));
  };

  /** The session a `{start:false}` create answered with, or `null` if the body says none. */
  const sessionIdOf = (body: unknown): string | null => {
    const id = (body as { session?: { id?: unknown } } | undefined)?.session?.id;
    return typeof id === 'string' && id !== '' ? id : null;
  };

  const openItem = async (arg: unknown, focus?: ItemFocus): Promise<void> => {
    const item = needsItem(arg);
    if (item === null) return;
    const path = itemPathOf(item.id);
    if (path === null) return;
    await openTab(deps, path, focus);
  };

  return [
    host.registerCommand('cgremlin.openItem', (arg) => openItem(arg)),

    /**
     * P10: the panel's notice offers this, and so does the command palette. Running it ALWAYS
     * opens — the user asking directly outranks a "Not now" they clicked earlier, which is also
     * why the dismissal is cleared here.
     */
    host.registerCommand('cgremlin.openManagedWorkspace', async () => {
      panel.clearWorkspaceNoticeDismissal();
      await deps.swapper?.openManagedWorkspace();
    }),

    // R48/R65: a child opens the SAME tab, focused on that child, and is addressed by the
    // child's own path rather than by the row's id.
    host.registerCommand('cgremlin.openChild', async (arg, childArg) => {
      const item = needsItem(arg);
      const childId = idOf(childArg);
      if (item === null || childId === null) return;
      const child = panel.childOf(item.id, childId);
      if (child === undefined || child.path === null) return;
      await openTab(deps, child.path, child.focus);
    }),

    host.registerCommand('cgremlin.chat', async (arg, childArg) => {
      // Three callers: a row action and an agent child's "Resume" NAME the agent (R48), and the
      // Item tab hands over its selected session id directly. What is deliberately not used
      // here is `sessionOf`: the item's first agent, or the one the window happens to be on,
      // may be a respond agent still at `triaging`, which is exactly what R50 gates off.
      const item = itemOf(arg);
      const named = agentOfChildId(idOf(childArg));
      const id = named ?? (item === null ? idOf(arg) : chatTargetOf(item));
      if (id === null) {
        void host.showWarningMessage(
          'That item has no conversation to join yet — an agent that is still triaging has nothing to talk about.',
          undefined,
        );
        return;
      }
      await chat.open(id);
    }),

    host.registerCommand('cgremlin.startReview', async (arg) => {
      const item = needsItem(arg);
      if (item === null) return;
      if (item.prs.length === 0) {
        void host.showWarningMessage(`'${item.title}' has no pull request to review.`, undefined);
        return;
      }
      const path = itemPathOf(item.id);
      if (path === null) return;
      // The forward-only ladder's last stage is a review of MY OWN change; the core needs to be
      // told, because a review of one's own PR is otherwise 409 `OwnPrError` (R42).
      const selfReview = item.prs[0]?.isMine === true;
      const body = selfReview ? { mode: 'review', selfReview: true } : { mode: 'review' };
      // Optimistic BEFORE the request, so the row says `running` while the
      // engine is still answering — and cleared if it refuses.
      panel.setPendingStart(item.id, 'review');
      const result = await send(() => client.startAgent(path, body));
      if (!surface(result)) {
        panel.clearPendingStart(item.id);
        return;
      }
      coordinator.schedule();
      // 0c — a 2xx is not a start: the preflight answers 200 `started:false`, and the row must
      // not keep saying `running`. It is still put on screen: the refresh just scheduled brings
      // the reason (`needs input` worded as the engine's own line) into that row.
      if (!startedOf(result)) {
        panel.clearPendingStart(item.id);
        panel.reveal(item.id);
        return;
      }
      // The defect this answers: the engine DID start the review (session
      // created, queued -> reviewing, run.started) and the row silently left
      // the group the user was looking at, with nothing saying so. A start
      // that worked ends with the row on screen, open, in its new section.
      panel.reveal(item.id);
    }),

    /**
     * R50/R56: the click that creates the respond session **and starts its run**, then swaps to
     * that PR's worktree and stops there. No claim, no terminal — chat comes second, once the
     * phase is `addressing` or `ready`.
     */
    host.registerCommand('cgremlin.addressReview', async (arg) => {
      const item = needsItem(arg);
      if (item === null) return;
      const pr = item.prs[0];
      if (pr === undefined || pr.isMine !== true) {
        void host.showWarningMessage(
          `'${item.title}' is not a pull request of yours to respond to.`,
          undefined,
        );
        return;
      }
      const path = itemPathOf(prRefOf(pr));
      if (path === null) return;
      panel.setPendingStart(item.id, 'respond');
      const result = await send(() => client.startAgent(path, { mode: 'respond' }));
      if (!surface(result)) {
        panel.clearPendingStart(item.id);
        return;
      }
      coordinator.schedule();
      // 0c — blocked by the preflight: nothing runs, so no `running` row and no workspace swap.
      if (!startedOf(result)) {
        panel.clearPendingStart(item.id);
        panel.reveal(item.id);
        return;
      }
      panel.reveal(item.id);
      await openTab(deps, path);
    }),

    /**
     * Phase 15 §3 entry 1 — `Verify in QA`. One POST creates the QA session AND starts its run,
     * exactly as `Address review comments` does: the click IS the explicit ask, and anything
     * else hands the user an empty session and a second button. The item is addressed by its
     * merged PR's own path, because that is the lock key the automatic leg takes (E2/E9), so a
     * click and a tick can never both create.
     */
    host.registerCommand('cgremlin.verifyInQa', async (arg) => {
      const path = qaPathOf(arg);
      if (path === null) return;
      const item = itemOf(arg) as WorkItem;
      panel.setPendingStart(item.id, 'qa');
      const result = await send(() => client.startAgent(path, { mode: 'qa' }));
      if (!surface(result)) {
        panel.clearPendingStart(item.id);
        return;
      }
      coordinator.schedule();
      if (!startedOf(result)) {
        panel.clearPendingStart(item.id);
        panel.reveal(item.id);
        return;
      }
      panel.reveal(item.id);
    }),

    /**
     * Phase 18 item 3 — `Open core.json`, the remedy beside "This repo has no QA environment
     * configured". It opens the file the reason NAMES, at the line the key goes on: a sentence
     * that names a config key and then leaves the user to find the file is two thirds of a fix.
     */
    host.registerCommand('cgremlin.openCoreConfig', async (arg) => {
      const path = deps.configPath?.() ?? null;
      if (path === null || !host.fileExists(path)) {
        void host.showWarningMessage(
          path === null ? 'cgremlin has no core.json path to open.' : `${path} is not there yet.`,
          undefined,
        );
        return;
      }
      const slug = itemOf(arg)?.prs[0]?.repo ?? null;
      const line = configLineFor(host.readFileSlice(path, 0).text, slug);
      if (line === undefined) await host.openTextDocument(path);
      else await host.openTextDocument(path, line);
    }),

    /**
     * Phase 18 item 2 — `Find merged PRs`, the remedy beside "No pull request is linked to this
     * ticket yet."
     *
     * The user's normal case: his teammates merge without cgremlin sessions, so the engine has
     * never seen the PR and §8's gate can only refuse. This is ONE `gh pr list --search`
     * engine-side, bounded exactly as the automatic leg's own lookup is, and its answer is said
     * in words — a search that found nothing has to SAY so, or it is the same silence again.
     */
    host.registerCommand('cgremlin.discoverPrs', async (arg) => {
      const item = needsItem(arg);
      if (item === null) return;
      const key = item.ticket?.key ?? null;
      if (key === null) {
        void host.showWarningMessage(
          `'${item.title}' has no ticket to search pull requests for.`,
          undefined,
        );
        return;
      }
      const result = await send(() => client.discoverPrs(key));
      if (!surface(result)) return;
      coordinator.schedule();
      const body = result?.body as
        | { found?: { repo?: unknown; number?: unknown }[]; reason?: unknown }
        | undefined;
      const found = (body?.found ?? [])
        .filter((pr) => typeof pr.repo === 'string' && typeof pr.number === 'number')
        .map((pr) => prLabel({ repo: String(pr.repo), number: Number(pr.number) }));
      if (found.length > 0) {
        void host.showInformationMessage(
          `${key}: found ${found.join(', ')}.`,
          undefined,
        );
        return;
      }
      void host.showInformationMessage(
        typeof body?.reason === 'string' && body.reason !== ''
          ? body.reason
          : `No merged pull request mentions ${key}.`,
        undefined,
      );
    }),

    /**
     * Entry 2 — `Ask about QA` (R73). The session is created and its brief composed, but nothing
     * runs: the user just has questions. `chatTargetOfAgents` admits a qa agent from `queued`
     * onwards, so the conversation opens on the session this very response names.
     */
    host.registerCommand('cgremlin.askQa', async (arg) => {
      const path = qaPathOf(arg);
      if (path === null) return;
      const result = await send(() => client.startAgent(path, { mode: 'qa', start: false }));
      if (!surface(result)) return;
      coordinator.schedule();
      const id = sessionIdOf(result?.body);
      if (id === null) {
        void host.showWarningMessage('The engine created no QA session to talk to.', undefined);
        return;
      }
      await chat.open(id);
    }),

    /**
     * Item 1: the user's own name for a row. Reachable from the expanded area and from the
     * palette-free command the panel posts; an empty input clears it, and the derived description
     * comes back. Nothing is sent to the engine — the core has no field for this, and the panel
     * is not going to become a writer of work items.
     */
    host.registerCommand('cgremlin.renameItem', async (arg) => {
      const item = needsItem(arg);
      if (item === null) return;
      const current = readTitle(host, item);
      const value = await host.showInputBox({
        title: 'Rename item',
        prompt: 'Your own title for this item. Leave it empty to go back to the derived one.',
        // The derived line as the placeholder, so the user can see what he is replacing.
        placeHolder: descriptionOf(item),
        value: current,
        ignoreFocusOut: true,
      });
      if (value === undefined) return;
      writeTitle(host, item, value);
      panel.reloadTitles();
    }),

    /**
     * Item 2: put an item aside, or take it back. The row moves on the CLICK — a refresh is a
     * round trip away, and a list that only reacted after it would read as a click that did
     * nothing — and a request the engine refuses moves it straight back, with the engine's own
     * wording. That failure is worth a message: it is the panel admitting it lied for a moment.
     */
    host.registerCommand('cgremlin.dismissItem', (arg) => setDismissed(deps, arg, true)),
    host.registerCommand('cgremlin.undismissItem', (arg) => setDismissed(deps, arg, false)),

    host.registerCommand('cgremlin.startInvestigation', (arg) =>
      startFromItem(deps, arg, 'investigation'),
    ),
    host.registerCommand('cgremlin.startDevelopment', (arg) =>
      startFromItem(deps, arg, 'development'),
    ),
    /**
     * Phase 21 — the SAME verb as `startDevelopment` wherever the rule table decided this item
     * has an investigation to continue from (`row-actions.promotableInvestigation`). The engine
     * creates the child session, copies FINDINGS.md and PLAN.md across and starts the develop
     * turn; the refusals it owns (a claimed human turn, an unapproved plan) reach the user as the
     * engine's own sentence rather than as a second opinion from here.
     */
    host.registerCommand('cgremlin.promoteToDevelopment', (arg, childArg) =>
      onNamedSession(arg, childArg, (id) => client.promote(id)),
    ),

    host.registerCommand('cgremlin.openPr', async (arg, childArg) => {
      const item = needsItem(arg);
      if (item === null) return;
      const childId = idOf(childArg);
      const pr =
        childId === null
          ? item.prs[0]
          : (item.prs.find((candidate) => prRefOf(candidate) === childId) ??
            item.prs[0]);
      if (pr === undefined) return;
      await host.openExternal(pr.url);
    }),

    host.registerCommand('cgremlin.openTicket', async (arg) => {
      const item = needsItem(arg);
      if (item === null || item.ticket === null) return;
      await host.openExternal(item.ticket.url);
    }),

    /**
     * Phase 21 — the human's decision, addressed at the session the row's verb NAMED. It used to
     * take `sessionOf(item)` (the chat target), which on an item carrying two sessions is not
     * necessarily the investigation whose plan is ready.
     */
    host.registerCommand('cgremlin.approvePlan', (arg, childArg) =>
      onNamedSession(arg, childArg, (id) => client.approvePlan(id)),
    ),
    /**
     * The human's approval on the pull request the NAMED review session reviewed. The engine
     * reads the repo and the number out of that session; nothing here can name another one.
     */
    host.registerCommand('cgremlin.approvePr', async (arg, childArg) => {
      const answer = await host.showWarningMessage(
        APPROVE_PR_CONFIRM_TEXT,
        { modal: true },
        APPROVE_PR_CONFIRM_LABEL,
      );
      if (answer !== APPROVE_PR_CONFIRM_LABEL) return;
      await onNamedSession(arg, childArg, (id) => client.approvePr(id));
    }),
    host.registerCommand('cgremlin.stop', async (arg, childArg) => {
      const item = needsItem(arg);
      if (item === null) return;
      const named = agentOfChildId(idOf(childArg));
      const id = named ?? sessionOf(item);
      if (id === null) {
        void host.showWarningMessage('That item has no session to act on.', undefined);
        return;
      }
      const answer = await host.showWarningMessage(
        STOP_RUN_CONFIRM_TEXT,
        { modal: true },
        STOP_RUN_CONFIRM_LABEL,
      );
      if (answer !== STOP_RUN_CONFIRM_LABEL) return;
      if (surface(await send(() => client.stop(id)))) coordinator.schedule();
    }),
    /**
     * Defect 4 — the read-only half of a refusal that used to be a dead end. Chat stays refused
     * while a run is live (two writers on one transcript is unrecoverable corruption); this opens
     * the Item tab on that session's Output pane instead, which is safe and is what the user was
     * actually asking for. No claim, no POST — it only starts listening.
     */
    host.registerCommand('cgremlin.watchRun', async (arg, childArg) => {
      const item = needsItem(arg);
      if (item === null) return;
      const id = agentOfChildId(idOf(childArg)) ?? sessionOf(item);
      if (id === null) {
        void host.showWarningMessage('That item has no run to watch.', undefined);
        return;
      }
      const path = itemPathOf(item.id);
      if (path === null) return;
      await openTab(deps, path);
      await deps.itemTab.watchRun(id);
    }),
    host.registerCommand('cgremlin.retry', (arg) => onSession(arg, (id) => client.retry(id))),
    /**
     * 0c — "Run anyway": the engine's preflight could not load the linked Jira ticket and started
     * nothing. This re-issues the SAME stage with `skipJiraCheck: true`, and the brief says the
     * ticket was skipped. Offered only for a `Jira …` block — GitHub is never skippable, so a
     * `GitHub …` block (or none) sends nothing.
     */
    host.registerCommand('cgremlin.runAnyway', async (arg) => {
      const item = needsItem(arg);
      if (item === null) return;
      const block = preflightBlockOf(item);
      if (block === null || !block.runAnyway || block.stage === null) {
        void host.showWarningMessage(
          `'${item.title}' has no run blocked on its Jira ticket to run anyway.`,
          undefined,
        );
        return;
      }
      const stage = block.stage;
      const result = await send(() =>
        client.run(block.sessionId, stage, { skipJiraCheck: true }),
      );
      if (!surface(result)) return;
      coordinator.schedule();
      // `/sessions/:id/run` answers 202 when the run started and 200 when the preflight blocked it.
      if (result?.status !== 202) {
        void host.showWarningMessage(
          'The run did not start: the engine still could not run it. The item says why.',
          undefined,
        );
      }
    }),
    /**
     * Defect 3 — the inverse of the claim `ChatSessions.open` takes, and the first button in the
     * extension ever to call `POST /sessions/:id/conversation/release`. `CoreClient.release`
     * answers 200 on a session nobody holds, so a stale row costs the user nothing.
     */
    host.registerCommand('cgremlin.releaseConversation', (arg, childArg) =>
      onNamedSession(arg, childArg, (id) => client.releaseConversation(id)),
    ),
    /**
     * Phase 21 — Retry's opposite number for a session whose failed run already produced its
     * artifact. `retry` re-runs `lastRun.stage`; this runs the stage that never got to run, which
     * `runPlan` has always accepted from `findings` (it re-checks FINDINGS.md under the session's
     * own lock, and its refusal is the sentence the user gets).
     */
    host.registerCommand('cgremlin.continueToPlan', (arg, childArg) =>
      onNamedSession(arg, childArg, (id) => client.run(id, 'plan')),
    ),

    // R31: one request. The core fans the ack out over every ref the item contributes.
    host.registerCommand('cgremlin.ack', async (arg) => {
      const item = needsItem(arg);
      if (item === null) return;
      const path = itemPathOf(item.id);
      if (path === null) return;
      if (surface(await send(() => client.ackItem(path)))) coordinator.schedule();
    }),

    host.registerCommand('cgremlin.refreshInventory', () => {
      // Check first, then speak. The bug this replaces read the LAST KNOWN engine state, showed a
      // conclusion, and only then re-probed — so a user could be told "not ready (mismatch)" by an
      // engine that had been healthy for fourteen hours. Now the probe runs first and the message
      // (if any) describes what it actually found.
      //
      // `refreshInFlight` shares one probe (and one message) across a burst of clicks: the probe
      // itself is already bounded (`EngineManager.probeOrRetry` caps retries, and a spawn attempt
      // is capped by `START_TIMEOUT_MS`), and a rejection is caught rather than left to hang the
      // command or crash it — the click still gets an answer, off whatever health was last known.
      if (refreshInFlight !== null) return refreshInFlight;
      const run = (async () => {
        if (deps.engine !== undefined) {
          try {
            await deps.engine.reprobe();
          } catch {
            // A probe that failed outright is not a hang: fall through and report on whatever the
            // engine last told us rather than leaving the click with no answer at all.
          }
        }
        const blocked = deps.engine === undefined ? null : refreshBlockedMessage(deps.engine.health());
        if (blocked !== null) {
          void host.showInformationMessage(blocked, undefined);
          return;
        }
        if (surface(await send(() => client.scan()))) coordinator.schedule();
      })();
      refreshInFlight = run.finally(() => {
        if (refreshInFlight === run) refreshInFlight = null;
      });
      return refreshInFlight;
    }),

    host.registerCommand('cgremlin.newInvestigation', async () => {
      const repo = await pickRepo(deps, 'Which repo should the investigation run in?');
      if (repo === undefined) return;
      const ticket = await askTicket(host);
      if (ticket === undefined) return;
      const intent = await host.showQuickPick([...INTENTS], {
        placeHolder: 'Is this investigation development-bound?',
      });
      if (intent === undefined) return;
      const drive = await host.showQuickPick([...DRIVE], {
        placeHolder: 'Stop at the plan, or drive to completion?',
      });
      if (drive === undefined) return;

      const result = await send(() =>
        client.createInvestigation({
          repoUrl: repoUrlOf(repo),
          ticket,
          intent: intent === INTENTS[1] ? 'development' : 'investigate_only',
          driveToCompletion: drive === DRIVE[1],
        }),
      );
      await createdThenRun(deps, result, 'findings');
    }),

    host.registerCommand('cgremlin.newDevelopmentSession', async () => {
      const repo = await pickRepo(deps, 'Which repo should the development session run in?');
      if (repo === undefined) return;
      const ticket = await askTicket(host);
      if (ticket === undefined) return;
      const result = await send(() =>
        client.createDevelopment({ repoUrl: repoUrlOf(repo), ticket }),
      );
      await createdThenRun(deps, result, 'develop');
    }),

    host.registerCommand('cgremlin.newReviewFromUrl', async () => {
      const url = await host.showInputBox({
        title: 'New review from PR URL',
        prompt: 'Any GitHub pull request URL, including a repo the scan does not watch.',
        placeHolder: 'https://github.com/owner/repo/pull/123',
        ignoreFocusOut: true,
        validateInput: (value) => validatePrUrl(value),
      });
      if (url === undefined) return;
      const result = await send(() => client.createReviewFromUrl(url));
      if (result === null) return;
      if (result.status < 200 || result.status >= 300) {
        // 409 (own PR), 400 (unparseable) — the url stays in the text so it can be corrected.
        void host.showWarningMessage(`${engineErrorText(result.body)} (${url})`, undefined);
        return;
      }
      const session = sessionIdOf(result.body);
      if (session === null) {
        void host.showWarningMessage('The engine created no session for that URL.', undefined);
        return;
      }
      // R23: a PR that already has a review session answers 200 `created: false` — the caller's
      // intent was satisfied, so this reveals the existing item instead of reporting an error.
      // P10: and it does so without a popup — the tab this opens IS the answer.
      if (createdFlag(result.body) === false) {
        host.log(`cgremlin: ${url} already has a review session ('${session}').`);
      }
      coordinator.schedule();
      await openSession(deps, session);
    }),
  ];
}

/** How a user command asks for the engine: `ensureRunning('user')`, through the engine surface. */
function reviveOf(deps: CommandDeps): EngineRevival {
  const engine = deps.engine;
  return engine === undefined ? undefined : () => engine.reprobe();
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One engine request from a user command, with the one retry a click earns. `null` means both
 * attempts found no engine at all, and the engine's own wording has already been shown.
 */
async function sendTo(
  deps: CommandDeps,
  work: () => Promise<HttpResult>,
): Promise<HttpResult | null> {
  try {
    return await withEngineRetry(reviveOf(deps), work);
  } catch (err: unknown) {
    void deps.host.showWarningMessage(messageOf(err), undefined);
    return null;
  }
}

/** The Item tab's own fetch gets the same treatment: the tab is a user command's destination. */
async function openTab(deps: CommandDeps, path: string, focus?: ItemFocus): Promise<void> {
  await deps.itemTab.open(path, focus, reviveOf(deps));
}

/** Item 2's optimistic dismissal, with the rollback that keeps the panel honest. */
async function setDismissed(deps: CommandDeps, arg: unknown, dismissed: boolean): Promise<void> {
  const { host, client, coordinator, panel } = deps;
  const id = typeof arg === 'string' ? arg : null;
  const item = id === null ? null : (panel.itemOf(id) ?? coordinator.itemOf(id) ?? null);
  if (item === null) {
    void host.showWarningMessage('Pick an item in the cgremlin panel first.', undefined);
    return;
  }
  const path = itemPathOf(item.id);
  if (path === null) {
    void host.showWarningMessage(
      `The engine cannot be addressed for '${item.title}' (unrecognised item id '${item.id}').`,
      undefined,
    );
    return;
  }
  panel.setPendingDismissal(item.id, dismissed);
  let result: HttpResult;
  try {
    // P11: a click is a request for the engine, so a dead socket is asked once to come back
    // before this is called a failure and the row is put back where it was.
    result = await withEngineRetry(reviveOf(deps), () =>
      dismissed ? client.dismissItem(path) : client.undismissItem(path),
    );
  } catch (err: unknown) {
    panel.clearPendingDismissal(item.id);
    void host.showWarningMessage(
      `Could not ${dismissed ? 'dismiss' : 'restore'} '${item.title}': ${
        err instanceof Error ? err.message : String(err)
      }`,
      undefined,
    );
    return;
  }
  if (result.status < 200 || result.status >= 300) {
    panel.clearPendingDismissal(item.id);
    void host.showWarningMessage(engineErrorText(result.body), undefined);
    return;
  }
  coordinator.schedule();
}

/**
 * R15: a session needs a repo. When the item has a PR the repo is known; a ticket-only row must
 * be asked, because a Jira ticket does not know which repo it belongs to and guessing would
 * create a worktree in the wrong place.
 */
async function startFromItem(
  deps: CommandDeps,
  arg: unknown,
  mode: 'investigation' | 'development',
): Promise<void> {
  const { host, client, coordinator, panel } = deps;
  const id = typeof arg === 'string' ? arg : null;
  const item = id === null ? null : (panel.itemOf(id) ?? coordinator.itemOf(id) ?? null);
  if (item === null) {
    void host.showWarningMessage('Pick an item in the cgremlin panel first.', undefined);
    return;
  }
  const path = itemPathOf(item.id);
  if (path === null) {
    // Never a silent return: the click has to end in a session or in a sentence.
    void host.showWarningMessage(
      `The engine cannot be addressed for '${item.title}' (unrecognised item id '${item.id}').`,
      undefined,
    );
    return;
  }
  const repoUrl = await repoUrlFor(deps, item, mode);
  if (repoUrl === undefined) return;
  panel.setPendingStart(item.id, mode);
  let result: HttpResult;
  try {
    result = await withEngineRetry(reviveOf(deps), () =>
      client.startAgent(path, { mode, repoUrl }),
    );
  } catch (err: unknown) {
    panel.clearPendingStart(item.id);
    // A dead socket rejects rather than answering, and a command that rejects fails where nobody
    // is looking — which is the whole complaint this path exists to answer. By here the engine
    // has already been asked for once, with the trigger a person's click earns.
    void host.showWarningMessage(
      `Could not start the ${mode}: ${err instanceof Error ? err.message : String(err)}`,
      undefined,
    );
    return;
  }
  if (result.status < 200 || result.status >= 300) {
    panel.clearPendingStart(item.id);
    void host.showWarningMessage(engineErrorText(result.body), undefined);
    return;
  }
  // Only a start that WORKED settles the question of which repo this item lives in.
  if (item.prs.length === 0) void host.setState(repoStateKey(item.id), repoUrl);
  coordinator.schedule();
  // 0c — the engine runs no preflight on these two stages today; should it ever answer
  // `started:false`, the row must not claim `running` nor swap the workspace to it.
  if (!startedOf(result)) {
    panel.clearPendingStart(item.id);
    panel.reveal(item.id);
    return;
  }
  // R56's answer to "nothing happened": the row this click was about is selected and open, so the
  // slot that just went `running` is on screen, and the tab swaps the workspace to its worktree.
  panel.reveal(item.id);
  await openTab(deps, path);
}

/** Where an item's chosen repo is remembered — for a ticket row, one entry per ticket key. */
function repoStateKey(itemId: string): string {
  return `cgremlin.startRepo.${itemId}`;
}

/**
 * The repo a ticket-only start runs in, asked for exactly once. A PR settles it; so does an
 * earlier successful start on the same ticket; so does a config with a single repo. Only a real
 * choice reaches the quick pick, and `undefined` means "the user did not choose" — nothing is
 * sent, because a start in the wrong repo creates a worktree in the wrong place (R15).
 */
async function repoUrlFor(
  deps: CommandDeps,
  item: WorkItem,
  mode: 'investigation' | 'development',
): Promise<string | undefined> {
  const repo = item.prs[0]?.repo;
  if (repo !== undefined) return repoUrlOf(repo);
  const remembered = deps.host.getState<string>(repoStateKey(item.id));
  if (typeof remembered === 'string' && remembered !== '') return remembered;
  const repos = (await deps.coordinator.ensureConfig())?.repos ?? [];
  if (repos.length === 1) return repoUrlOf(repos[0]);
  const picked = await pickRepo(deps, `Which repo should the ${mode} run in?`);
  return picked === undefined ? undefined : repoUrlOf(picked);
}

/** The config says there are none — the only case in which blaming a file is the true thing. */
export const NO_REPOS_MESSAGE = 'No repos are configured in core.json.';

/**
 * The config was never read, so nothing here is known about `core.json` at all. The fact is
 * about reaching the engine, and the message carries the way through rather than a culprit.
 */
export const REPOS_UNREADABLE_MESSAGE =
  'cgremlin could not read its configuration from the engine, so it does not know your repos ' +
  'yet. Start the engine and try again.';

const START_THE_ENGINE = 'Start the engine';

async function pickRepo(deps: CommandDeps, placeHolder: string): Promise<string | undefined> {
  // An empty list has two very different causes, and the user was told the wrong one: a window
  // whose first connect failed (an engine restart at install time) has NO config, and reported
  // that as "no repos are configured" about a file it had never read.
  const config = await deps.coordinator.ensureConfig();
  if (config === null) {
    const choice = await deps.host.showWarningMessage(
      REPOS_UNREADABLE_MESSAGE,
      undefined,
      START_THE_ENGINE,
    );
    if (choice === START_THE_ENGINE) await deps.host.executeCommand('cgremlin.engine.start');
    return undefined;
  }
  const repos = config.repos;
  if (repos.length === 0) {
    void deps.host.showWarningMessage(NO_REPOS_MESSAGE, undefined);
    return undefined;
  }
  // `ignoreFocusOut`, because the panel is a webview: it restores its own focus on the next
  // render, and a quick pick without this is dismissed by that repaint — the command then returns
  // `undefined` and the click looks like it did nothing at all.
  return await deps.host.showQuickPick(repos, { placeHolder, ignoreFocusOut: true });
}

/** `undefined` means the user cancelled; `null` means "no ticket". */
async function askTicket(host: Host): Promise<string | null | undefined> {
  const value = await host.showInputBox({
    title: 'Ticket',
    prompt: 'Ticket id, or empty for none.',
    placeHolder: 'ABC-123',
    ignoreFocusOut: true,
    validateInput: (input) => validateTicket(input),
  });
  if (value === undefined) return undefined;
  return value === '' ? null : value;
}

function repoUrlOf(slug: string): string {
  return `https://github.com/${slug}.git`;
}

/** Create, then one explicit run, then open. Nothing is started that was not asked for. */
async function createdThenRun(
  deps: CommandDeps,
  result: HttpResult | null,
  stage: string,
): Promise<void> {
  const { host, client, coordinator } = deps;
  if (result === null) return;
  if (result.status < 200 || result.status >= 300) {
    void host.showWarningMessage(engineErrorText(result.body), undefined);
    return;
  }
  const session = sessionIdOf(result.body);
  if (session === null) {
    void host.showWarningMessage('The engine created a session but did not describe it.', undefined);
    return;
  }
  const run = await sendTo(deps, () => client.run(session, stage));
  if (run !== null && (run.status < 200 || run.status >= 300)) {
    void host.showWarningMessage(engineErrorText(run.body), undefined);
  }
  coordinator.schedule();
  await openSession(deps, session);
}

/** A just-created session has no `WorkItem` yet, so it is opened at its own `session/` path. */
async function openSession(deps: CommandDeps, sessionId: string): Promise<void> {
  const path = itemPathOf(`session:${sessionId}`);
  if (path !== null) await openTab(deps, path);
}

/**
 * 0c — did a 2xx start route actually start a run? The engine answers 200 `started:false` when
 * its preflight blocked it. A body that says nothing (an older engine) keeps meaning "started".
 */
function startedOf(result: HttpResult | null): boolean {
  const body = result?.body as { started?: unknown } | null | undefined;
  return !(typeof body === 'object' && body !== null && body.started === false);
}

/** `{ session: { id } }` — every creation route answers this shape. */
function sessionIdOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('session' in body)) return null;
  const session = (body as { session: unknown }).session;
  if (typeof session !== 'object' || session === null || !('id' in session)) return null;
  const id = (session as { id: unknown }).id;
  return typeof id === 'string' && id !== '' ? id : null;
}

function createdFlag(body: unknown): boolean | null {
  if (typeof body !== 'object' || body === null || !('created' in body)) return null;
  const created = (body as { created: unknown }).created;
  return typeof created === 'boolean' ? created : null;
}
