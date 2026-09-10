import { describe, expect, it } from 'vitest';
import { buildChatCommand, ChatCommandError } from '../src/model/chat-command';

const uuid = '7c3f9a10-2b4d-4e51-9f00-8a1b2c3d4e5f';

describe('buildChatCommand', () => {
  it('resumes a Claude Code transcript', () => {
    expect(buildChatCommand({ runner: 'claude-code', resumeId: uuid })).toBe(`claude --resume '${uuid}'`);
  });

  it('starts a fresh Claude Code conversation when there is nothing to resume', () => {
    expect(buildChatCommand({ runner: 'claude-code', resumeId: null })).toBe('claude');
  });

  it('resumes a codex transcript', () => {
    expect(buildChatCommand({ runner: 'codex', resumeId: uuid })).toBe(`codex resume '${uuid}'`);
  });

  it('starts a fresh codex conversation', () => {
    expect(buildChatCommand({ runner: 'codex', resumeId: null })).toBe('codex');
  });
});

describe('MG-B4 chat-always-runs-in-the-worktree (the pure half)', () => {
  it('never emits --resume with a null id', () => {
    for (const runner of ['claude-code', 'codex'] as const) {
      const command = buildChatCommand({ runner, resumeId: null });
      expect(command).not.toContain('--resume');
      expect(command).not.toContain('resume');
    }
  });

  it('rejects an id that is not UUID-shaped rather than escaping it', () => {
    for (const bad of [`${uuid}'`, `${uuid} x`, `${uuid};rm -rf /`, `$(id)`, '', 'id$USER']) {
      expect(() => buildChatCommand({ runner: 'claude-code', resumeId: bad })).toThrow(ChatCommandError);
      expect(() => buildChatCommand({ runner: 'codex', resumeId: bad })).toThrow(ChatCommandError);
    }
  });

  it('quotes the id it does accept', () => {
    expect(buildChatCommand({ runner: 'claude-code', resumeId: 'abc-123' })).toBe("claude --resume 'abc-123'");
  });

  it('refuses to guess a command for an unknown runner', () => {
    expect(() => buildChatCommand({ runner: null, resumeId: uuid })).toThrow(ChatCommandError);
    expect(() =>
      buildChatCommand({ runner: 'gemini' as unknown as 'codex', resumeId: null }),
    ).toThrow(ChatCommandError);
  });
});
