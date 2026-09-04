import { unlink } from 'node:fs/promises';
import { NodeFileSystem } from '../fs/node-file-system';
import { NodeGitRunner } from '../git/node-git-runner';
import { NodeGhRunner } from '../gh/node-gh-runner';
import { ClaudeCodeRunner } from '../agent/claude-code-runner';
import { CodexRunner } from '../agent/codex-runner';
import type { AgentRunner } from '../agent/agent-runner';
import type { CoreConfig } from '../config/core-config';
import { listenOnSocket } from '../api/listen';
import { buildEngine, type EngineAdapters } from './build-engine';

export interface ServeHandle {
  socketPath: string;
  close(): Promise<void>;
  onSignal(sig: NodeJS.Signals): void;
}

export interface ServeOptions {
  log: (line: string) => void;
  verbose?: boolean;
  signals?: readonly NodeJS.Signals[];
}

function logLine(log: (line: string) => void, type: string, payload: Record<string, unknown> = {}): void {
  log(JSON.stringify({ ts: new Date().toISOString(), type, ...payload }));
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

  const engine = buildEngine(config, adapters);
  const { server, scheduler, pipeline, events, store } = engine;

  const unsubscribers: Array<() => void> = [
    events.on('session.created', (e) => logLine(opts.log, 'session.created', { sessionId: e.session.id })),
    events.on('session.transitioned', (e) =>
      logLine(opts.log, 'session.transitioned', { sessionId: e.session.id, from: e.from, to: e.to }),
    ),
    events.on('run.started', (e) => logLine(opts.log, 'run.started', { sessionId: e.session.id, stage: e.stage })),
    events.on('run.finished', (e) =>
      logLine(opts.log, 'run.finished', { sessionId: e.session.id, stage: e.stage, outcome: e.outcome }),
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
    void close();
  };
  const processHandlers = signals.map((sig) => {
    const handler = () => signalHandler(sig);
    process.on(sig, handler);
    return { sig, handler };
  });

  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    scheduler.stop();
    const sessions = await store.list();
    for (const session of sessions) {
      if (session.lastRun?.outcome === 'running') {
        await pipeline.stop(session.id);
      }
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(socketPath).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
    for (const off of unsubscribers) off();
    for (const { sig, handler } of processHandlers) process.removeListener(sig, handler);
  }

  return {
    socketPath,
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
