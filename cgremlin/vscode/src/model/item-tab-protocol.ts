/**
 * The Item tab's two message unions and their parser (R21, R39).
 *
 * The webview is untrusted input: `parseWebviewMessage` recognises a fixed set of shapes, copies
 * **only** the fields it knows about, and returns `null` for everything else — an unknown type, a
 * missing or wrongly typed field, or a `{"__proto__": …}` payload.
 *
 * Pure module — no editor API (MG-B1).
 */

export type ItemFocusMessage =
  | { kind: 'agent'; sessionId: string }
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
  assignee: string | null;
  descriptionText: string | null;
  comments: { author: string; at: string; bodyText: string | null }[];
}

export interface TabButton {
  id: string;
  label: string;
  enabled: boolean;
  /** Why it is disabled, shown as the title — an inert button with no explanation is a bug. */
  reason?: string;
}

export interface ItemTabState {
  itemId: string;
  title: string;
  needsYou: boolean;
  chips: { label: string; url: string }[];
  focus: ItemFocusMessage;
  selectedSessionId: string | null;
  agents: TabAgent[];
  prs: TabPr[];
  ticket: TabTicket | null;
  ticketError: string | null;
  /** Decided by the host (R42/R51), rendered by the webview — the rule is not a style. */
  buttons: TabButton[];
}

export type HostToWebview =
  | { type: 'render'; state: ItemTabState }
  | { type: 'patch'; artifact: TabArtifact };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'selectAgent'; sessionId: string }
  | { type: 'setFocus'; focus: ItemFocusMessage }
  | { type: 'command'; command: string; arg?: string }
  | { type: 'openLink'; url: string };

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
    default:
      return null;
  }
}
