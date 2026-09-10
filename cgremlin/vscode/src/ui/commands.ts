/**
 * Every contributed command, and the creation flows.
 *
 * Two rules shape this file:
 *  - the engine's own wording for a refusal is shown verbatim (`engineErrorText`) — its 4xx
 *    messages are written for humans, and paraphrasing them loses the instruction they carry;
 *  - a request that the API would reject for a reason the widget could have caught is never sent:
 *    the ticket input and the PR-URL input validate with mirrors of the core's own rules.
 */
import { engineErrorText, type CoreClient, type HttpResult } from '../core-client';
import { displayTitle } from '../model/items';
import type { AttentionItem, ListItem } from '../model/items';
import type { DisposableLike, Host } from './host';
import type { TreeNode } from './tree';
import type { ItemOpener, OpenTarget } from './preview';
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
const ROWS_THAT_CAN_START_A_REVIEW = new Set(['parking', 'reviewing']);

export interface CommandDeps {
  host: Host;
  client: CoreClient;
  coordinator: RefreshCoordinator;
  opener: ItemOpener;
  chat: ChatSessions;
  /** `cgremlin.configPath`, used only by the `Start it` terminal command. */
  configPath: () => string;
}

export function registerCommands(deps: CommandDeps): DisposableLike[] {
  const { host, client, coordinator, opener, chat } = deps;

  const target = (arg: unknown): OpenTarget | null => resolveTarget(arg, coordinator.items());
  const sessionIdOf = (arg: unknown): string | null => target(arg)?.sessionId ?? null;

  const surface = (result: HttpResult): boolean => {
    if (result.status >= 200 && result.status < 300) return true;
    void host.showWarningMessage(engineErrorText(result.body), undefined);
    return false;
  };

  const needsRow = (arg: unknown): ListItem | null => {
    const row = rowOf(arg);
    if (row === null) {
      void host.showWarningMessage('Pick an item in the cgremlin panel first.', undefined);
    }
    return row;
  };

  const onSession = async (
    arg: unknown,
    call: (id: string) => Promise<HttpResult>,
  ): Promise<void> => {
    const id = sessionIdOf(arg);
    if (id === null) {
      void host.showWarningMessage('That item has no session to act on.', undefined);
      return;
    }
    if (surface(await call(id))) coordinator.schedule();
  };

  const openTarget = async (arg: unknown): Promise<void> => {
    const resolved = target(arg);
    if (resolved === null) {
      void host.showWarningMessage('Pick an item in the cgremlin panel first.', undefined);
      return;
    }
    await opener.open(resolved);
  };

  return [
    host.registerCommand('cgremlin.openItem', (arg) => openTarget(arg)),

    host.registerCommand('cgremlin.chat', async (arg) => {
      const id = sessionIdOf(arg);
      if (id === null) {
        void host.showWarningMessage('That item has no conversation to join.', undefined);
        return;
      }
      await chat.open(id);
    }),

    host.registerCommand('cgremlin.startReview', async (arg) => {
      const row = needsRow(arg);
      if (row === null) return;
      if (!ROWS_THAT_CAN_START_A_REVIEW.has(row.kind)) {
        void host.showWarningMessage(
          `'${row.label}' is a session, not a pull request in the inventory.`,
          undefined,
        );
        return;
      }
      const { prRepo, prNumber } = row.item.links;
      if (prRepo === null || prNumber === null) {
        void host.showWarningMessage(`'${row.label}' has no pull request to review.`, undefined);
        return;
      }
      if (surface(await client.startReview(prRepo, prNumber))) coordinator.schedule();
    }),

    host.registerCommand('cgremlin.approvePlan', (arg) => onSession(arg, (id) => client.approvePlan(id))),
    host.registerCommand('cgremlin.stop', (arg) => onSession(arg, (id) => client.stop(id))),
    host.registerCommand('cgremlin.retry', (arg) => onSession(arg, (id) => client.retry(id))),

    // Acknowledgement is keyed by the generic item ref, so a PR with no session acks the same way.
    host.registerCommand('cgremlin.ack', async (arg) => {
      const ref = refOf(arg);
      if (ref === null) {
        void host.showWarningMessage('Pick an item in the cgremlin panel first.', undefined);
        return;
      }
      if (surface(await client.ack(ref))) coordinator.schedule();
    }),

    host.registerCommand('cgremlin.refreshInventory', async () => {
      if (surface(await client.scan())) coordinator.schedule();
    }),

    host.registerCommand('cgremlin.refreshPreview', async () => {
      await host.executeCommand('markdown.preview.refresh');
    }),

    host.registerCommand('cgremlin.startEngine', () => {
      const terminal = host.createTerminal({ name: 'cgremlin-core' });
      terminal.show();
      terminal.sendText(`cgremlin-core serve --config ${deps.configPath()}`);
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
      const session = sessionOf(result.body);
      if (session === null) {
        void host.showWarningMessage('The engine created no session for that URL.', undefined);
        return;
      }
      // R23: a PR that already has a review session answers 200 `created: false` — the caller's
      // intent was satisfied, so this reveals the existing item instead of reporting an error.
      if (createdFlag(result.body) === false) {
        void host.showInformationMessage(
          `${url} already has a review session ('${session.sessionId}').`,
          undefined,
        );
      }
      coordinator.schedule();
      await opener.open(session);
    }),
  ];
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
  const { host, client, coordinator, opener } = deps;
  if (result.status < 200 || result.status >= 300) {
    void host.showWarningMessage(engineErrorText(result.body), undefined);
    return;
  }
  const session = sessionOf(result.body);
  if (session === null) {
    void host.showWarningMessage('The engine created a session but did not describe it.', undefined);
    return;
  }
  const run = await client.run(session.sessionId, stage);
  if (run.status < 200 || run.status >= 300) {
    void host.showWarningMessage(engineErrorText(run.body), undefined);
  }
  coordinator.schedule();
  await opener.open(session);
}

// --- argument plumbing -----------------------------------------------------

function rowOf(arg: unknown): ListItem | null {
  if (typeof arg !== 'object' || arg === null) return null;
  const node = arg as TreeNode;
  return node.kind === 'row' ? node.row : null;
}

function refOf(arg: unknown): string | null {
  const row = rowOf(arg);
  if (row !== null) return row.item.ref;
  return typeof arg === 'string' && arg !== '' ? arg : null;
}

function targetOfItem(item: AttentionItem): OpenTarget {
  return {
    sessionId: item.links.sessionId,
    title: displayTitle(item),
    worktreePath: item.links.worktreePath,
    prUrl: item.links.prUrl,
  };
}

/**
 * A command argument is a tree node (the usual case), an item ref or session id (a popup action,
 * a just-created session), or an already-built target (the creation flows).
 */
export function resolveTarget(arg: unknown, items: readonly AttentionItem[]): OpenTarget | null {
  const row = rowOf(arg);
  if (row !== null) return targetOfItem(row.item);
  if (typeof arg === 'string' && arg !== '') {
    const found = items.find((i) => i.ref === arg || i.links.sessionId === arg);
    return found === undefined
      ? { sessionId: arg, title: arg, worktreePath: null, prUrl: null }
      : targetOfItem(found);
  }
  if (typeof arg === 'object' && arg !== null && 'sessionId' in arg) {
    const candidate = arg as OpenTarget;
    if (typeof candidate.sessionId === 'string' || candidate.sessionId === null) return candidate;
  }
  return null;
}

/** `{ session: { id, workspace?, pr? } }` — every creation route answers this shape. */
function sessionOf(body: unknown): (OpenTarget & { sessionId: string }) | null {
  if (typeof body !== 'object' || body === null || !('session' in body)) return null;
  const session = (body as { session: unknown }).session;
  if (typeof session !== 'object' || session === null || !('id' in session)) return null;
  const id = (session as { id: unknown }).id;
  if (typeof id !== 'string' || id === '') return null;
  const workspace = (session as { workspace?: { worktreePath?: unknown } }).workspace;
  const pr = (session as { pr?: { url?: unknown } | null }).pr;
  return {
    sessionId: id,
    title: id,
    worktreePath: typeof workspace?.worktreePath === 'string' ? workspace.worktreePath : null,
    prUrl: typeof pr?.url === 'string' ? pr.url : null,
  };
}

function createdFlag(body: unknown): boolean | null {
  if (typeof body !== 'object' || body === null || !('created' in body)) return null;
  const created = (body as { created: unknown }).created;
  return typeof created === 'boolean' ? created : null;
}
