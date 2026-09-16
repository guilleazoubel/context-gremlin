/**
 * The Item tab's two message unions and their parser (R21, R39).
 *
 * The webview is untrusted input: `parseWebviewMessage` recognises a fixed set of shapes, copies
 * **only** the fields it knows about, and returns `null` for everything else — an unknown type, a
 * missing or wrongly typed field, or a `{"__proto__": …}` payload.
 *
 * Pure module — no editor API (MG-B1).
 */

import type { TabPart } from './item-tab-parts';
import type { WorkListKind } from './work-items';

export type ItemFocusMessage =
  | { kind: 'agent'; sessionId: string }
  /** Phase 17 §2 — ONE artifact of one agent, which is what a part switcher addresses. */
  | { kind: 'artifact'; sessionId: string; name: string }
  | { kind: 'ticket' }
  | { kind: 'pr'; repo: string; number: number };

export interface TabArtifact {
  sessionId: string;
  name: string;
  mtime: string;
  /** `null` while the host is still fetching it; the body arrives over the channel (R19). */
  text: string | null;
}

export interface TabAgent {
  sessionId: string;
  mode: string;
  phase: string;
  running: boolean;
  /** Phase 18 — the last run failed, so the tab offers Retry beside Chat. */
  runFailed?: boolean;
  needsYou: boolean;
  claimed: boolean;
  /** The unicode badge glyph; there is no icon font under `font-src 'none'` (R54). */
  glyph: string;
  primaryArtifact: string | null;
  artifacts: TabArtifact[];
}

export interface TabPr {
  repo: string;
  number: number;
  url: string;
  title: string | null;
  state: string;
  reviewDecision: string | null;
  ci: string;
  isMine: boolean | null;
  isDraft: boolean | null;
  changedFiles: number | null;
  additions: number | null;
  deletions: number | null;
  /** Optional: present only when the engine's detail route supplies them. */
  reviewers: { login: string; state: string; body: string | null }[];
  checks: { name: string; state: string; detailsUrl: string | null }[];
  openThreads: number | null;
}

export interface TabTicket {
  key: string;
  summary: string;
  status: string;
  url: string;
  /** The account id — compared against `jira.me` upstream, so it stays the id. */
  assignee: string | null;
  /**
   * Phase 17 §5d — the assignee's display name. Optional on the wire: an engine built before the
   * field existed simply does not send it, and the pane falls back to the id rather than to ''.
   */
  assigneeName?: string | null;
  descriptionText: string | null;
  comments: { author: string; at: string; bodyText: string | null }[];
}

export interface TabButton {
  id: string;
  label: string;
  enabled: boolean;
  /**
   * Phase 17 §6 — `primary` is the one filled button, `inline` is bordered. The rule already
   * decided this (`model/row-actions`); the tab used to discard it and draw three equal buttons.
   */
  placement: 'primary' | 'inline';
  /** Why it is disabled, shown as a line beneath the row — an inert, silent button is a bug. */
  reason?: string;
}

export interface ItemTabState {
  itemId: string;
  title: string;
  needsYou: boolean;
  /**
   * The lists the item is in (`ItemDetailResponse.item.lists`). The tab is not scoped to one, so
   * its buttons are the union of what each of them allows — the same rule the panel rows use.
   */
  lists: WorkListKind[];
  chips: { label: string; url: string }[];
  focus: ItemFocusMessage;
  selectedSessionId: string | null;
  agents: TabAgent[];
  prs: TabPr[];
  ticket: TabTicket | null;
  ticketError: string | null;
  /** Decided by the host (R42/R51), rendered by the webview — the rule is not a style. */
  buttons: TabButton[];
  /**
   * Phase 18 §8's gate, the same two inputs the panel rows read off `GET /config`. Optional:
   * a tab rendered before the config resolved offers no QA verb at all, as it did before.
   */
  qaRepos?: string[];
  qaStatuses?: string[];
  /** The last automatic QA attempt could not reach the environment (`qaAttempt.outcome`). */
  qaUnreachable?: boolean;
  /**
   * Phase 17 §1 — the item's parts in their fixed order, which is what the tablist draws. Built
   * host-side by `model/item-tab-parts` so the webview picks no order of its own.
   */
  parts: TabPart[];
}

export type HostToWebview =
  | { type: 'render'; state: ItemTabState }
  | { type: 'patch'; artifact: TabArtifact };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'selectAgent'; sessionId: string }
  | { type: 'setFocus'; focus: ItemFocusMessage }
  | { type: 'command'; command: string; arg?: string }
  | { type: 'openLink'; url: string }
  /** Phase 17 §3 — a `path:line` clicked inside a review. The host decides whether it may open. */
  | { type: 'openFile'; path: string; line: number };

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  // A payload that carries its own `__proto__` key is refused outright rather than read around:
  // nothing legitimate sends one, and "we only copy known fields" is easier to trust when the
  // shape it would have to defeat never gets that far.
  if (Object.prototype.hasOwnProperty.call(value, '__proto__')) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function parseFocus(value: unknown): ItemFocusMessage | null {
  const focus = record(value);
  if (focus === null) return null;
  if (focus.kind === 'ticket') return { kind: 'ticket' };
  if (focus.kind === 'agent') {
    const sessionId = text(focus.sessionId);
    return sessionId === null ? null : { kind: 'agent', sessionId };
  }
  if (focus.kind === 'artifact') {
    const sessionId = text(focus.sessionId);
    const name = text(focus.name);
    return sessionId === null || name === null
      ? null
      : { kind: 'artifact', sessionId, name };
  }
  if (focus.kind === 'pr') {
    const repo = text(focus.repo);
    const number = focus.number;
    if (repo === null || typeof number !== 'number' || !Number.isInteger(number)) return null;
    return { kind: 'pr', repo, number };
  }
  return null;
}

/** `http(s)` only: the host hands the url straight to the editor's external opener. */
function parseUrl(value: unknown): string | null {
  const url = text(value);
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export function parseWebviewMessage(raw: unknown): WebviewToHost | null {
  const message = record(raw);
  if (message === null) return null;
  switch (message.type) {
    case 'ready':
      return { type: 'ready' };
    case 'selectAgent': {
      const sessionId = text(message.sessionId);
      return sessionId === null ? null : { type: 'selectAgent', sessionId };
    }
    case 'setFocus': {
      const focus = parseFocus(message.focus);
      return focus === null ? null : { type: 'setFocus', focus };
    }
    case 'command': {
      const command = text(message.command);
      if (command === null) return null;
      const arg = text(message.arg);
      return arg === null ? { type: 'command', command } : { type: 'command', command, arg };
    }
    case 'openLink': {
      const url = parseUrl(message.url);
      return url === null ? null : { type: 'openLink', url };
    }
    case 'openFile': {
      // The shape only. WHERE the path may point is the host's question, because only the host
      // knows which worktree the selected agent is on.
      const path = text(message.path);
      const line = message.line;
      if (path === null || typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
        return null;
      }
      return { type: 'openFile', path, line };
    }
    default:
      return null;
  }
}
