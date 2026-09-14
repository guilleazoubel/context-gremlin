/**
 * The words the extension says when the engine on the socket is not one it can use.
 *
 * They live in a pure module because three surfaces must say the *same* thing — the tree's
 * explanatory row, the status bar and the notification — and because the real failure this
 * covers (an old hand-started engine holding the socket) is a string problem before it is
 * anything else: the user has to be told which socket, and what to do about it.
 */
import { describe, expect, it } from 'vitest';
import {
  OUTDATED_EXTENSION_MESSAGE,
  RELOAD_WINDOW,
  RE_PROBE,
  SHOW_LOG,
  SHOW_LOG_ROW,
  healthOf,
  refreshBlockedMessage,
  troubleActionLabel,
  troubleCommand,
  troubleMessage,
  troubleOf,
  troubleRowLabel,
  troubleSecondary,
  troubleStatusText,
  type EngineHealth,
} from '../../src/model/engine-trouble';

const SOCKET = '/home/me/.cgremlin-core/engine.sock';

function health(over: Partial<EngineHealth> = {}): EngineHealth {
  return { kind: 'running', socketPath: SOCKET, ...over };
}

describe('the actions', () => {
  it('names the two buttons every surface offers', () => {
    expect(RE_PROBE).toBe('Re-probe');
    expect(SHOW_LOG).toBe('Show log');
    expect(SHOW_LOG_ROW).toBe('show log');
  });
});

describe('turning an engine state into a health report', () => {
  it('carries the socket path with every kind', () => {
    expect(healthOf({ kind: 'foreign' }, SOCKET)).toEqual({ kind: 'foreign', socketPath: SOCKET });
  });

  it('carries a failure reason and a stopping elapsed time', () => {
    expect(healthOf({ kind: 'failed', reason: 'boom', logTail: [] }, SOCKET)).toEqual({
      kind: 'failed',
      socketPath: SOCKET,
      reason: 'boom',
    });
    expect(healthOf({ kind: 'stopping', since: 0, pid: 3, elapsedMs: 1_000 }, SOCKET)).toEqual({
      kind: 'stopping',
      socketPath: SOCKET,
      elapsedMs: 1_000,
    });
  });
});

describe('which states are trouble', () => {
  it('is exactly foreign, failed, outdated and stopped', () => {
    expect(troubleOf(health({ kind: 'foreign' }))).toEqual({ kind: 'foreign', socketPath: SOCKET });
    expect(troubleOf(health({ kind: 'failed', reason: 'boom' }))).toEqual({
      kind: 'failed',
      reason: 'boom',
    });
    expect(troubleOf(health({ kind: 'outdated' }))).toEqual({ kind: 'outdated' });
    // An engine that is not running at all is the state the incident ended in, and the panel owes
    // the user the one click that brings it back rather than four silently empty lists.
    expect(troubleOf(health({ kind: 'stopped' }))).toEqual({ kind: 'notRunning' });
    for (const kind of ['unknown', 'starting', 'running', 'stopping', 'mismatch'] as const) {
      expect(troubleOf(health({ kind })), kind).toBeNull();
    }
  });

  /**
   * The incident's own ending: the respawn budget spent, the engine dead, and a row whose only
   * offer was "show log". Starting the engine is the primary act; the log is the second one.
   */
  it('offers a Start button first and the log second whenever there is no engine', () => {
    for (const trouble of [
      { kind: 'failed', reason: 'boom' },
      { kind: 'notRunning' },
    ] as const) {
      expect(troubleCommand(trouble), trouble.kind).toBe('cgremlin.engine.start');
      expect(troubleActionLabel(trouble), trouble.kind).toBe('Start the engine');
      expect(troubleSecondary(trouble), trouble.kind).toEqual({
        command: 'cgremlin.engine.showLog',
        actionLabel: SHOW_LOG,
      });
    }
  });

  it('offers no second action for a stranger on the socket or a window that is behind', () => {
    expect(troubleSecondary({ kind: 'foreign', socketPath: SOCKET })).toBeNull();
    expect(troubleSecondary({ kind: 'outdated' })).toBeNull();
  });

  it('says the engine is not running, and how to refuse a refresh in the same words', () => {
    const message = troubleMessage({ kind: 'notRunning' });
    expect(message).toContain('is not running');
    expect(refreshBlockedMessage(health({ kind: 'stopped' }))).toBe(message);
    expect(troubleStatusText({ kind: 'notRunning' })).toContain('engine is not running');
  });

  it('reports a failure with no reason at all rather than an empty sentence', () => {
    expect(troubleOf(health({ kind: 'failed' }))).toEqual({
      kind: 'failed',
      reason: 'the engine did not start',
    });
  });
});

/**
 * The half of the restart ping-pong the user sees. The window that is behind adopts the newer
 * engine and never signals it — so the only thing left to say is that this window is the stale
 * one, with the one action that fixes it.
 */
describe('the outdated-extension wording', () => {
  it('asks for a reload, and offers the editor\'s own reload command', () => {
    const trouble = { kind: 'outdated' } as const;
    expect(troubleMessage(trouble)).toBe(OUTDATED_EXTENSION_MESSAGE);
    expect(troubleMessage(trouble)).toContain('older cgremlin extension');
    expect(troubleMessage(trouble)).toContain('reload the window');
    expect(troubleCommand(trouble)).toBe('workbench.action.reloadWindow');
    expect(troubleActionLabel(trouble)).toBe(RELOAD_WINDOW);
    expect(troubleStatusText(trouble)).toContain('reload this window');
    expect(troubleRowLabel(trouble)).toBe(OUTDATED_EXTENSION_MESSAGE);
  });

  it('blocks a refresh with the same sentence', () => {
    expect(refreshBlockedMessage(health({ kind: 'outdated' }))).toBe(OUTDATED_EXTENSION_MESSAGE);
  });
});

describe('the foreign wording', () => {
  it('interpolates the socket path and names the command that fixes it', () => {
    const message = troubleMessage({ kind: 'foreign', socketPath: SOCKET });
    expect(message).toContain(SOCKET);
    expect(message).toContain('not a cgremlin engine this extension can use');
    expect(message).toContain('older engine you started by hand');
    expect(message).toContain('cgremlin: Start the engine');
  });

  it('says "the cgremlin socket" rather than null when no config has resolved yet', () => {
    const message = troubleMessage({ kind: 'foreign', socketPath: null });
    expect(message).not.toContain('null');
    expect(message).toContain('the cgremlin socket');
  });

  it('shows the same sentence in the tree row, and re-probes when it is clicked', () => {
    const trouble = { kind: 'foreign', socketPath: SOCKET } as const;
    expect(troubleRowLabel(trouble)).toBe(troubleMessage(trouble));
    expect(troubleCommand(trouble)).toBe('cgremlin.engine.start');
    expect(troubleStatusText(trouble)).toBe('$(warning) cgremlin: engine not usable');
  });
});

describe('the failed wording', () => {
  const trouble = { kind: 'failed', reason: 'the engine exited with code 1' } as const;

  it('shows the failure verbatim, and adds show log to the row', () => {
    expect(troubleMessage(trouble)).toContain('the engine exited with code 1');
    expect(troubleRowLabel(trouble)).toContain('the engine exited with code 1');
    expect(troubleRowLabel(trouble)).toContain(SHOW_LOG_ROW);
  });

  it('starts the engine when the row is clicked, and keeps the log a button away', () => {
    expect(troubleCommand(trouble)).toBe('cgremlin.engine.start');
    expect(troubleSecondary(trouble)?.command).toBe('cgremlin.engine.showLog');
    expect(troubleStatusText(trouble)).toBe('$(warning) cgremlin: engine failed');
  });
});

describe('what Refresh says when the engine is not running', () => {
  it('says nothing at all when it is', () => {
    expect(refreshBlockedMessage(health({ kind: 'running' }))).toBeNull();
  });

  it('reuses the trouble wording verbatim', () => {
    expect(refreshBlockedMessage(health({ kind: 'foreign' }))).toBe(
      troubleMessage({ kind: 'foreign', socketPath: SOCKET }),
    );
    expect(refreshBlockedMessage(health({ kind: 'failed', reason: 'boom' }))).toBe(
      troubleMessage({ kind: 'failed', reason: 'boom' }),
    );
  });

  it('names the state, and the command, for every other kind', () => {
    for (const kind of ['unknown', 'starting', 'stopping', 'mismatch'] as const) {
      const message = refreshBlockedMessage(health({ kind }));
      expect(message, kind).toContain(kind);
      expect(message, kind).toContain('cgremlin: Start the engine');
    }
  });
});
