/**
 * Chat: hand the session's conversation to the human, in a terminal, in the worktree.
 *
 * Three properties are load-bearing:
 *  - `cwd` is always the worktree, because the transcript store is cwd-keyed (MG-B4);
 *  - a refused claim (409 while a run is in flight, R9) creates **no** terminal — two agents on one
 *    transcript is unrecoverable corruption;
 *  - the claim is renewed every TTL/3 while the terminal is open and released when it closes
 *    (R20), so a crashed host or a killed terminal lapses the claim instead of wedging the session.
 */
import { buildChatCommand } from '../model/chat-command';
import { engineErrorText, CoreHttpError, type CoreClient } from '../core-client';
import { PendingWork, type Host, type TerminalLike } from './host';

/** The core's own default (`CoreConfig.humanTurnTtlMs`), used only if `/config` omits it. */
export const DEFAULT_HUMAN_TURN_TTL_MS = 600_000;

/** A third of the TTL: two heartbeats may be lost before a live conversation lapses. */
export function heartbeatIntervalMs(ttlMs: number | undefined): number {
  const ttl = typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0
    ? ttlMs
    : DEFAULT_HUMAN_TURN_TTL_MS;
  return Math.max(1000, Math.floor(ttl / 3));
}

export interface ChatSessionsDeps {
  host: Host;
  client: CoreClient;
  /** Read per chat, never captured: `/config` is refetched on every reconnect. */
  ttlMs: () => number | undefined;
}

interface ChatEntry {
  sessionId: string;
  stopHeartbeat: () => void;
}

export class ChatSessions {
  private readonly entries = new Map<TerminalLike, ChatEntry>();
  private readonly pending = new PendingWork();

  constructor(private readonly deps: ChatSessionsDeps) {}

  async open(sessionId: string): Promise<void> {
    const { host, client } = this.deps;
    const existing = [...this.entries].find(([, entry]) => entry.sessionId === sessionId);
    if (existing !== undefined) {
      existing[0].show();
      return;
    }

    let command: string;
    let cwd: string;
    try {
      const conversation = await client.conversation(sessionId);
      if (conversation.worktreePath === null) {
        void host.showWarningMessage(
          `Session '${sessionId}' has no worktree to chat in.`,
          undefined,
        );
        return;
      }
      cwd = conversation.worktreePath;
      command = buildChatCommand(conversation);
    } catch (err) {
      void host.showWarningMessage(messageOf(err), undefined);
      return;
    }

    try {
      await client.claim(sessionId);
    } catch (err) {
      void host.showWarningMessage(messageOf(err), undefined);
      return;
    }

    const terminal = host.createTerminal({ name: `cgremlin: ${sessionId}`, cwd });
    terminal.show();
    terminal.sendText(command);
    const stopHeartbeat = host.setInterval(
      () => this.pending.track(this.heartbeat(sessionId)),
      heartbeatIntervalMs(this.deps.ttlMs()),
    );
    this.entries.set(terminal, { sessionId, stopHeartbeat });
  }

  private async heartbeat(sessionId: string): Promise<void> {
    try {
      await this.deps.client.claim(sessionId);
    } catch (err) {
      this.deps.host.log(`cgremlin: heartbeat for '${sessionId}' failed: ${messageOf(err)}`);
    }
  }

  /** `window.onDidCloseTerminal` — clears the interval as well as releasing (R20). */
  handleClosed(terminal: TerminalLike): void {
    const entry = this.entries.get(terminal);
    if (entry === undefined) return;
    this.entries.delete(terminal);
    entry.stopHeartbeat();
    this.pending.track(this.release(entry.sessionId));
  }

  /** `deactivate` — every outstanding claim, and every interval. */
  async releaseAll(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) entry.stopHeartbeat();
    await Promise.allSettled(entries.map((entry) => this.release(entry.sessionId)));
    await this.pending.settled();
  }

  private async release(sessionId: string): Promise<void> {
    try {
      await this.deps.client.release(sessionId);
    } catch (err) {
      this.deps.host.log(`cgremlin: releasing '${sessionId}' failed: ${messageOf(err)}`);
    }
  }

  settled(): Promise<void> {
    return this.pending.settled();
  }
}

function messageOf(err: unknown): string {
  if (err instanceof CoreHttpError) return engineErrorText(err.body);
  return err instanceof Error ? err.message : String(err);
}
