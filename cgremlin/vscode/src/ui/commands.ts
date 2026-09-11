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
import { engineErrorText, type CoreClient, type HttpResult } from '../core-client';
import { refreshBlockedMessage } from '../model/engine-trouble';
import { itemPathOf, type ItemFocus, type WorkItem } from '../model/work-items';
import type { EngineHealthSource } from './engine';
import type { DisposableLike, Host } from './host';
import type { ItemTab } from './item-tab';
import type { PanelView } from './panel-view';
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

export interface CommandDeps {
  host: Host;
  client: CoreClient;
  coordinator: RefreshCoordinator;
  panel: PanelView;
  itemTab: ItemTab;
  chat: ChatSessions;
  /**
   * The engine's own surface, when there is one. Refresh consults it first: a scan sent to a
   * socket with no usable engine on it fails invisibly, and the panel simply stays as it was.
   */
  engine?: EngineHealthSource;
}

export function registerCommands(deps: CommandDeps): DisposableLike[] {
  const { host, client, coordinator, panel, itemTab, chat } = deps;

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

  const surface = (result: HttpResult): boolean => {
    if (result.status >= 200 && result.status < 300) return true;
    void host.showWarningMessage(engineErrorText(result.body), undefined);
    return false;
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
    if (surface(await call(id))) coordinator.schedule();
  };

  const openItem = async (arg: unknown, focus?: ItemFocus): Promise<void> => {
    const item = needsItem(arg);
    if (item === null) return;
    const path = itemPathOf(item.id);
    if (path === null) return;
    await itemTab.open(path, focus);
  };

  return [
    host.registerCommand('cgremlin.openItem', (arg) => openItem(arg)),

    // R48/R65: a child opens the SAME tab, focused on that child, and is addressed by the
    // child's own path rather than by the row's id.
    host.registerCommand('cgremlin.openChild', async (arg, childArg) => {
      const item = needsItem(arg);
      const childId = idOf(childArg);
      if (item === null || childId === null) return;
      const child = panel.childOf(item.id, childId);
      if (child === undefined || child.path === null) return;
      await itemTab.open(child.path, child.focus);
    }),

    host.registerCommand('cgremlin.chat', async (arg) => {
      // A popup and a row hand over an item id; the Item tab hands over a session id directly.
      const item = itemOf(arg);
      const id = item === null ? idOf(arg) : sessionOf(item);
      if (id === null) {
        void host.showWarningMessage('That item has no conversation to join.', undefined);
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
      if (surface(await client.startAgent(path, { mode: 'review' }))) coordinator.schedule();
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
      const path = itemPathOf(`pr:${pr.repo}#${pr.number}`);
      if (path === null) return;
      if (!surface(await client.startAgent(path, { mode: 'respond' }))) return;
      coordinator.schedule();
      await itemTab.open(path);
    }),

    host.registerCommand('cgremlin.startInvestigation', (arg) =>
      startFromItem(deps, arg, 'investigation'),
    ),
    host.registerCommand('cgremlin.startDevelopment', (arg) =>
      startFromItem(deps, arg, 'development'),
    ),

    host.registerCommand('cgremlin.openPr', async (arg, childArg) => {
      const item = needsItem(arg);
      if (item === null) return;
      const childId = idOf(childArg);
      const pr =
        childId === null
          ? item.prs[0]
          : (item.prs.find((candidate) => `pr:${candidate.repo}#${candidate.number}` === childId) ??
            item.prs[0]);
      if (pr === undefined) return;
      await host.openExternal(pr.url);
    }),

    host.registerCommand('cgremlin.openTicket', async (arg) => {
      const item = needsItem(arg);
      if (item === null || item.ticket === null) return;
      await host.openExternal(item.ticket.url);
    }),

    host.registerCommand('cgremlin.approvePlan', (arg) =>
      onSession(arg, (id) => client.approvePlan(id)),
    ),
    host.registerCommand('cgremlin.stop', (arg) => onSession(arg, (id) => client.stop(id))),
    host.registerCommand('cgremlin.retry', (arg) => onSession(arg, (id) => client.retry(id))),

    // R31: one request. The core fans the ack out over every ref the item contributes.
    host.registerCommand('cgremlin.ack', async (arg) => {
      const item = needsItem(arg);
      if (item === null) return;
      const path = itemPathOf(item.id);
      if (path === null) return;
      if (surface(await client.ackItem(path))) coordinator.schedule();
    }),

    host.registerCommand('cgremlin.refreshInventory', async () => {
      // Nothing to refresh, and — the bug this replaces — no sign of why. The wording is the
      // panel row's own, and the command re-probes so the fix (stopping an old engine) takes
      // effect without hunting for a second command.
      const blocked = deps.engine === undefined ? null : refreshBlockedMessage(deps.engine.health());
      if (blocked !== null) {
        void host.showInformationMessage(blocked, undefined);
        await deps.engine?.reprobe();
        return;
      }
      if (surface(await client.scan())) coordinator.schedule();
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

      const result = await client.createInvestigation({
        repoUrl: repoUrlOf(repo),
        ticket,
        intent: intent === INTENTS[1] ? 'development' : 'investigate_only',
        driveToCompletion: drive === DRIVE[1],
      });
      await createdThenRun(deps, result, 'findings');
    }),

    host.registerCommand('cgremlin.newDevelopmentSession', async () => {
      const repo = await pickRepo(deps, 'Which repo should the development session run in?');
      if (repo === undefined) return;
      const ticket = await askTicket(host);
      if (ticket === undefined) return;
      const result = await client.createDevelopment({ repoUrl: repoUrlOf(repo), ticket });
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
      const result = await client.createReviewFromUrl(url);
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
      if (createdFlag(result.body) === false) {
        void host.showInformationMessage(
          `${url} already has a review session ('${session}').`,
          undefined,
        );
      }
      coordinator.schedule();
      await openSession(deps, session);
    }),
  ];
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
  if (path === null) return;
  const repo = item.prs[0]?.repo;
  let repoUrl: string;
  if (repo !== undefined) {
    repoUrl = repoUrlOf(repo);
  } else {
    const picked = await pickRepo(deps, `Which repo should the ${mode} run in?`);
    if (picked === undefined) return;
    repoUrl = repoUrlOf(picked);
  }
  const result = await client.startAgent(path, { mode, repoUrl });
  if (result.status < 200 || result.status >= 300) {
    void host.showWarningMessage(engineErrorText(result.body), undefined);
    return;
  }
  coordinator.schedule();
  await deps.itemTab.open(path);
}

async function pickRepo(deps: CommandDeps, placeHolder: string): Promise<string | undefined> {
  const repos = deps.coordinator.config()?.repos ?? [];
  if (repos.length === 0) {
    void deps.host.showWarningMessage('No repos are configured in core.json.', undefined);
    return undefined;
  }
  return await deps.host.showQuickPick(repos, { placeHolder });
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
  result: HttpResult,
  stage: string,
): Promise<void> {
  const { host, client, coordinator } = deps;
  if (result.status < 200 || result.status >= 300) {
    void host.showWarningMessage(engineErrorText(result.body), undefined);
    return;
  }
  const session = sessionIdOf(result.body);
  if (session === null) {
    void host.showWarningMessage('The engine created a session but did not describe it.', undefined);
    return;
  }
  const run = await client.run(session, stage);
  if (run.status < 200 || run.status >= 300) {
    void host.showWarningMessage(engineErrorText(run.body), undefined);
  }
  coordinator.schedule();
  await openSession(deps, session);
}

/** A just-created session has no `WorkItem` yet, so it is opened at its own `session/` path. */
async function openSession(deps: CommandDeps, sessionId: string): Promise<void> {
  const path = itemPathOf(`session:${sessionId}`);
  if (path !== null) await deps.itemTab.open(path);
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
