/**
 * The command the chat terminal types. The terminal's `cwd` is always the session's worktree
 * (the transcript store is cwd-keyed), which the host supplies — this module only builds the
 * command line (MG-B4).
 *
 * Pure module — no editor API (MG-B1).
 */

/** Real resume ids are UUID-shaped. Anything else is refused, never escaped. */
const RESUME_ID = /^[A-Za-z0-9-]+$/;

export class ChatCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatCommandError';
  }
}

export interface ChatCommandInput {
  runner: 'claude-code' | 'codex' | null;
  resumeId: string | null;
}

export function buildChatCommand(input: ChatCommandInput): string {
  const { runner, resumeId } = input;
  if (runner !== 'claude-code' && runner !== 'codex') {
    throw new ChatCommandError(`No chat command for runner '${String(runner)}'`);
  }
  if (resumeId !== null && !RESUME_ID.test(resumeId)) {
    throw new ChatCommandError(`Refusing to resume an id that is not UUID-shaped: '${resumeId}'`);
  }
  if (runner === 'claude-code') {
    return resumeId === null ? 'claude' : `claude --resume '${resumeId}'`;
  }
  return resumeId === null ? 'codex' : `codex resume '${resumeId}'`;
}
