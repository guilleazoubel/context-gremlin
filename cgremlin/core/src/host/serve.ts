import { execFile } from 'node:child_process';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { NodeFileSystem } from '../fs/node-file-system';
import { NodeGitRunner } from '../git/node-git-runner';
import { NodeGhRunner } from '../gh/node-gh-runner';
import { ClaudeCodeRunner } from '../agent/claude-code-runner';
import { CodexRunner } from '../agent/codex-runner';
import type { AgentRunner } from '../agent/agent-runner';
import type { CoreConfig } from '../config/core-config';
import { redactBypassUrls } from '../config/core-config';
import { NodeLocalAppRunner } from '../env/node-local-app-runner';
import { isSocketLive, listenOnSocket, SocketInUseError } from '../api/listen';
import { buildEngine, type BuildEngineOptions, type Engine, type EngineAdapters } from './build-engine';

const DEFAULT_SERVER_CLOSE_TIMEOUT_MS = 5000;

/** The mode the lock file is created with — the same 0600 `writeCoreConfig` uses for core.json. */
const ENGINE_LOCK_MODE = 0o600;

interface EngineLockRecord {
  pid: number;
  version: string;
  socketPath: string;
  startedAt: string;
}

/**
 * W8's classification, reused verbatim: ESRCH means the target is already
 * gone, EPERM means it is alive but belongs to somebody else. Anything else
 * is a real fault and still throws.
 * (`src/env/node-local-app-runner.ts:249-262`.)
 */
function pidLiveness(pid: number): 'alive' | 'gone' | 'foreign' {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'gone';
    if (code === 'EPERM') return 'foreign';
    throw err;
  }
}

/**
 * Reads a pid's command line — the second half of "is this lock's owner
 * really our engine?". `null` means we could not find out (ps failed, timed
 * out, or the pid vanished mid-call), which callers treat conservatively.
 */
export type ProcessCommandReader = (pid: number) => Promise<string | null>;

const PS_TIMEOUT_MS = 2000;

const nodeProcessCommand: ProcessCommandReader = (pid) =>
  new Promise((resolve) => {
    execFile('ps', ['-o', 'command=', '-p', String(pid)], { timeout: PS_TIMEOUT_MS }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const command = stdout.trim();
      resolve(command === '' ? null : command);
    });
  });

/**
 * A pid alone proves nothing: pids get reused, and a crashed engine leaves
 * its `engine.json` behind. Without this check a recycled pid would make
 * every later `serve` refuse forever until somebody deleted the file by hand.
 * Both shapes the engine runs as: the CLI (`.../bin/cgremlin-core serve`) and
 * the bundle the editor spawns (`... engine.js serve`).
 */
function looksLikeEngineCommand(command: string): boolean {
  return command.includes('cgremlin-core') || command.includes('engine.js');
}

async function readLockRecord(lockPath: string): Promise<EngineLockRecord | null> {
  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<EngineLockRecord>;
    if (typeof parsed.pid !== 'number' || typeof parsed.socketPath !== 'string') return null;
    return parsed as EngineLockRecord;
  } catch {
    return null;
  }
}

async function writeLockRecord(lockPath: string, record: EngineLockRecord): Promise<void> {
  // Exclusive create, and the file is COMPLETE the instant it exists. A plain
  // open(path, 'wx') would also be exclusive, but it publishes a zero-byte
  // file that the loser can read before the winner has written a word — and a
  // record with no readable pid looks exactly like a dead owner to take over,
  // which is how two engines end up racing `listen`. So: write a temp file
  // first, then `link` it into place, which is atomic and fails EEXIST.
  // SessionFileSystem has no exclusive create, so this goes straight to
  // node:fs/promises — the same bypass serve() already makes for the socket.
  const tmpPath = `${lockPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmpPath, JSON.stringify(record, null, 2), { mode: ENGINE_LOCK_MODE });
  try {
    await link(tmpPath, lockPath);
  } finally {
    await unlink(tmpPath).catch(() => undefined);
  }
}

/**
 * R22: `engine.json` is the lock, and it is taken BEFORE `listenOnSocket`.
 * `listenOnSocket` cannot be the primitive — its liveness test is a *connect*
 * and it unlinks a socket nobody answers, so two engines starting at the same
 * moment can both proceed and the loser can unlink the winner's fresh socket.
 *
 * On EEXIST the recorded owner is probed two ways — is its pid alive, and does
 * its socket answer. Either signal positive refuses this boot with
 * `SocketInUseError`; provably negative on both takes the lock over, once.
 */
async function acquireEngineLock(
  lockPath: string,
  record: EngineLockRecord,
  readProcessCommand: ProcessCommandReader,
): Promise<void> {
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeLockRecord(lockPath, record);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const owner = await readLockRecord(lockPath);
    // Somebody beat us to the retake — they are alive by definition. Report
    // THEIR socket, not ours: ours is the one nobody is listening on.
    if (attempt > 0) throw new SocketInUseError(owner?.socketPath ?? record.socketPath);
    // An unreadable or truncated file proves no live owner by itself, but its
    // socket still might be served — so the socket probe runs either way.
    const ownerSocket = owner?.socketPath ?? record.socketPath;
    if (owner !== null && pidLiveness(owner.pid) !== 'gone') {
      // Alive and serving: unambiguously the owner, no need to ask ps.
      if (await isSocketLive(ownerSocket)) throw new SocketInUseError(ownerSocket);
      // Alive but silent: either an engine still booting, or a stranger who
      // inherited the pid after a crash left this file behind.
      const command = await readProcessCommand(owner.pid);
      if (command === null) {
        throw new SocketInUseError(
          ownerSocket,
          `pid ${owner.pid} recorded in ${lockPath} could not be identified; delete that file if no engine is running`,
        );
      }
      if (looksLikeEngineCommand(command)) throw new SocketInUseError(ownerSocket);
      // Reused pid: the lock is stale, take it over.
    } else if (await isSocketLive(ownerSocket)) {
      throw new SocketInUseError(ownerSocket);
    }
    await unlink(lockPath).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }
}

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
  /** Overrides the real `ps -o command= -p <pid>` the lock uses to tell an engine from a reused pid — a test seam. */
  readProcessCommand?: ProcessCommandReader;
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
  const { server, scheduler, pipeline, events, environment, attention, engineInfo } = engine;
  const lockPath = config.enginePidPath!;

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
    events.on('attention.changed', (e) =>
      logLine(opts.log, 'attention.changed', {
        ref: e.item.ref,
        reasons: e.item.attention.reasons,
        needsYou: e.item.attention.needsYou,
      }),
    ),
    events.on('artifact.changed', (e) =>
      logLine(opts.log, 'artifact.changed', { sessionId: e.sessionId, name: e.name, mtime: e.mtime }),
    ),
  ];
  if (opts.verbose) {
    unsubscribers.push(
      // R3: an agent that echoes a bypass URL must never write the secret
      // into the engine's own log.
      events.on('run.output', (e) =>
        logLine(opts.log, 'run.output', {
          sessionId: e.sessionId,
          stage: e.stage,
          chunk: { ...e.chunk, data: redactBypassUrls(e.chunk.data) },
        }),
      ),
    );
  }

  // R22: the lock comes first — before the reap, before the claim clearing
  // and before we listen. A losing second engine must not clear the winner's
  // human-turn claims on its way to being refused.
  await acquireEngineLock(
    lockPath,
    {
      pid: engineInfo.pid,
      version: engineInfo.version,
      socketPath: engineInfo.socketPath,
      startedAt: engineInfo.startedAt,
    },
    opts.readProcessCommand ?? nodeProcessCommand,
  );
  async function removeLock(): Promise<void> {
    await unlink(lockPath).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }
  // Everything from here to `listen` returns by throwing, before any handle
  // exists, so a failure has to remove the lock this call created (R22).
  try {
    // R13: before anything can reach us, reap the process group a previous
    // engine recorded and then died without stopping — and only that one. A
    // failure here (e.g. a stuck `ps`/kill call) must not abort boot — the
    // engine should still come up and serve, just without having reaped.
    try {
      const reap = await environment?.reconcileOrphans();
      if (reap?.reaped) {
        const { sessionId, pid, pgid, port } = reap.reaped;
        logLine(opts.log, 'local.reaped', { sessionId, pid, pgid, port, alreadyDead: reap.alreadyDead });
      }
      // W3: a record we can no longer prove is ours (it predates this boot and
      // does not own its port) was dropped without signalling anything — say so,
      // because a pid recorded before a reboot may now belong to anybody.
      if (reap?.stale) {
        const { sessionId, pid, pgid, port } = reap.stale;
        logLine(opts.log, 'local.reap_stale', { sessionId, pid, pgid, port });
      }
    } catch (err) {
      logLine(opts.log, 'local.reap_failed', { error: err instanceof Error ? err.message : String(err) });
    }

    // R20: no extension can hold a human-turn claim across an engine restart it
    // did not survive, so every claim is cleared BEFORE anything can reach us —
    // otherwise an orphaned claim would refuse every stage on that session with
    // nothing left alive to release it.
    const clearedClaims = await pipeline.clearAllHumanTurns();
    if (clearedClaims.count > 0) {
      logLine(opts.log, 'conversation.claims_cleared', clearedClaims);
    }

    await listenOnSocket(server, socketPath);
  } catch (err) {
    await removeLock();
    throw err;
  }

  scheduler.start();
  // Subscribes the attention model to the engine events and starts the
  // session-directory watch it owns (R7). Nothing here starts an agent.
  attention.start();

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
      try {
        // StageRunner's in-memory active map is the only trustworthy source
        // of "what's actually running" — an on-disk lastRun.outcome==='running'
        // can be stale (a crashed engine, a session nobody ever resumed) and
        // stopping by that alone would be a no-op at best, misleading at worst.
        for (const id of pipeline.activeSessionIds()) {
          await pipeline.stop(id);
        }
      } finally {
        // R16: sessions first, local app second — an agent still mid-turn may
        // be talking to the dev server, so pulling it out from under a
        // running stage would look like an app crash rather than a shutdown.
        // environment.stop() must run even if a pipeline.stop() above threw,
        // or a failed session stop would leave the local app running forever.
        //
        // W4: abort first. A stage still PREPARING its environment has no
        // active run for pipeline.stop() to find, and its dev server may not
        // be on record yet — without this, close() would return while a
        // healthcheck kept waiting, and the stage would go on to spawn an
        // agent against an engine that is already gone.
        try {
          await environment?.abortAll();
        } catch (err) {
          firstError ??= err;
        }
        try {
          await environment?.stop();
        } catch (err) {
          firstError ??= err;
        }
      }
    } catch (err) {
      firstError = err;
    } finally {
      // Everything below must run even if the above threw, so a shutdown
      // never leaves the socket file, process listeners, or a hung server
      // behind — that would break a later `serve()` on the same socket.
      // Detached first, so a failed shutdown still leaves no watch behind and
      // no refresh racing the teardown.
      attention.stop();
      server.closeAllConnections();
      await closeServerWithTimeout(server, opts.serverCloseTimeoutMs ?? DEFAULT_SERVER_CLOSE_TIMEOUT_MS, opts.log);
      await unlink(socketPath).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err;
      });
      // R22: the lock is released in the same finally that unlinks the
      // socket — a close() that failed halfway must not leave a state dir
      // that refuses every later engine.
      await removeLock();
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
  return { fs, git, gh, runner, runnerKind: config.runner, localApp: new NodeLocalAppRunner() };
}
