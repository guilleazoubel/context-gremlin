import { unlink } from 'node:fs/promises';
import { NodeFileSystem } from '../fs/node-file-system';
import { NodeGitRunner } from '../git/node-git-runner';
import { NodeGhRunner } from '../gh/node-gh-runner';
import { ClaudeCodeRunner } from '../agent/claude-code-runner';
import { CodexRunner } from '../agent/codex-runner';
import type { AgentRunner } from '../agent/agent-runner';
import type { CoreConfig } from '../config/core-config';
import { listenOnSocket } from '../api/listen';
import { buildEngine, type BuildEngineOptions, type Engine, type EngineAdapters } from './build-engine';

const DEFAULT_SERVER_CLOSE_TIMEOUT_MS = 5000;

export interface ServeHandle {
  socketPath: string;
  /** Exposed for introspection/testing — the same wired parts `buildEngine` returned. */
  engine: Engine;
  close(): Promise<void>;
  onSignal(sig: NodeJS.Signals): void;
}

export interface ServeOptions {
  log: (line: string) => void;
  verbose?: boolean;
  signals?: readonly NodeJS.Signals[];
  makeTickable?: BuildEngineOptions['makeTickable'];
  /** How long close() waits for server.close() before giving up and logging shutdown.timeout. Default 5000. */
  serverCloseTimeoutMs?: number;
}

function logLine(log: (line: string) => void, type: string, payload: Record<string, unknown> = {}): void {
  log(JSON.stringify({ ts: new Date().toISOString(), type, ...payload }));
}

/**
 * Races `server.close()` against `timeoutMs`, always clearing the timer.
 * `closeAllConnections()` (called by the caller before this) should make
 * `server.close()` finish promptly even with connections open, but a
 * misbehaving/hung listener socket must never keep an engine shutdown
 * hanging forever — log and give up instead.
 */
async function closeServerWithTimeout(server: Engine['server'], timeoutMs: number, log: (line: string) => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = new Promise<'closed'>((resolve) => server.close(() => resolve('closed')));
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const result = await Promise.race([closed, timedOut]);
  clearTimeout(timer);
  if (result === 'timeout') {
    logLine(log, 'shutdown.timeout');
  }
}

/**
 * Wires the engine (via `buildEngine`), listens on `config.socketPath`,
 * starts the discovery scheduler, and logs one JSON line per engine event to
 * `opts.log`. Registers SIGINT/SIGTERM (or `opts.signals`) handlers that call
 * `close()`; tests should call `handle.onSignal(sig)` directly rather than
 * emitting a real process signal.
 */
export async function serve(config: CoreConfig, adapters: EngineAdapters, opts: ServeOptions): Promise<ServeHandle> {
  const sessionsDir = config.sessionsDir!;
  const worktreesDir = config.worktreesDir!;
  const mirrorsDir = config.mirrorsDir!;
  const socketPath = config.socketPath!;

  await adapters.fs.mkdir(sessionsDir, { recursive: true });
  await adapters.fs.mkdir(worktreesDir, { recursive: true });
  await adapters.fs.mkdir(mirrorsDir, { recursive: true });

  const engine = buildEngine(config, adapters, { makeTickable: opts.makeTickable });
  const { server, scheduler, pipeline, events } = engine;

  const unsubscribers: Array<() => void> = [
    events.on('session.created', (e) => logLine(opts.log, 'session.created', { sessionId: e.session.id })),
    events.on('session.transitioned', (e) =>
      logLine(opts.log, 'session.transitioned', { sessionId: e.session.id, from: e.from, to: e.to }),
    ),
    events.on('run.started', (e) => logLine(opts.log, 'run.started', { sessionId: e.session.id, stage: e.stage })),
    events.on('run.finished', (e) =>
      logLine(opts.log, 'run.finished', { sessionId: e.session.id, stage: e.stage, outcome: e.outcome }),
    ),
    events.on('inventory.updated', (e) =>
      logLine(opts.log, 'inventory.updated', { entries: e.inventory.entries.length, errors: e.inventory.errors.length }),
    ),
  ];
  if (opts.verbose) {
    unsubscribers.push(
      events.on('run.output', (e) => logLine(opts.log, 'run.output', { sessionId: e.sessionId, stage: e.stage, chunk: e.chunk })),
    );
  }

  await listenOnSocket(server, socketPath);
  scheduler.start();

  const signals = opts.signals ?? (['SIGINT', 'SIGTERM'] as const);
  const signalHandler = (sig: NodeJS.Signals): void => {
    logLine(opts.log, 'signal', { signal: sig });
    // Fire-and-forget from this synchronous handler's own perspective, but
    // still attach a rejection handler — close() is memoized below, so this
    // is the SAME promise any other caller (e.g. the CLI's serve command)
    // awaits; without this .catch, a rejecting close triggered by a signal
    // would be an unhandled rejection with nothing else to observe it.
    close().catch((err) => {
      logLine(opts.log, 'shutdown.error', { error: err instanceof Error ? err.message : String(err) });
    });
  };
  const processHandlers = signals.map((sig) => {
    const handler = () => signalHandler(sig);
    process.on(sig, handler);
    return { sig, handler };
  });

  let closingPromise: Promise<void> | undefined;
  function close(): Promise<void> {
    closingPromise ??= doClose();
    return closingPromise;
  }
  async function doClose(): Promise<void> {
    let firstError: unknown;
    try {
      // Await any tick already in flight BEFORE reading what's active: a
      // tick that fired just before shutdown could otherwise start a
      // rereview/agent after we've already begun tearing everything down,
      // leaving it running forever with nothing left to stop it.
      await scheduler.stop();
      // StageRunner's in-memory active map is the only trustworthy source
      // of "what's actually running" — an on-disk lastRun.outcome==='running'
      // can be stale (a crashed engine, a session nobody ever resumed) and
      // stopping by that alone would be a no-op at best, misleading at worst.
      for (const id of pipeline.activeSessionIds()) {
        await pipeline.stop(id);
      }
    } catch (err) {
      firstError = err;
    } finally {
      // Everything below must run even if the above threw, so a shutdown
      // never leaves the socket file, process listeners, or a hung server
      // behind — that would break a later `serve()` on the same socket.
      server.closeAllConnections();
      await closeServerWithTimeout(server, opts.serverCloseTimeoutMs ?? DEFAULT_SERVER_CLOSE_TIMEOUT_MS, opts.log);
      await unlink(socketPath).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err;
      });
      for (const off of unsubscribers) off();
      for (const { sig, handler } of processHandlers) process.removeListener(sig, handler);
    }
    if (firstError !== undefined) throw firstError;
  }

  return {
    socketPath,
    engine,
    close,
    onSignal: (sig) => signalHandler(sig),
  };
}

export function realAdapters(config: CoreConfig): EngineAdapters {
  const fs = new NodeFileSystem();
  const git = new NodeGitRunner();
  const gh = new NodeGhRunner();
  const runner: AgentRunner =
    config.runner === 'codex'
      ? new CodexRunner({ model: config.runnerOptions.model, sandbox: config.runnerOptions.sandbox })
      : new ClaudeCodeRunner({ model: config.runnerOptions.model, permissionMode: config.runnerOptions.permissionMode });
  return { fs, git, gh, runner, runnerKind: config.runner };
}
