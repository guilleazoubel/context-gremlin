/**
 * The engine's lifecycle, as a state machine with no I/O of its own.
 *
 * Pure module — every effect is an injected port, and (R30) the editor API is not named here even
 * in prose. That is what makes the dangerous half of this phase testable: this file decides when
 * to spawn a daemon and when to signal one, and the tests drive it on a fake clock.
 *
 * Two rules dominate the design:
 *  - **never a second engine** (MG-C1). A probe that answers is the end of the story: the engine is
 *    a machine-wide singleton keyed by its socket, and the extension adopts it rather than starting
 *    a rival. Concurrent triggers share one in-flight promise, the way `serve()`'s `close()` does.
 *  - **never signal what we cannot prove is ours** (MG-C2, R29). `engine.json` alone proves nothing
 *    (pids are reused) and a `/version` answer alone does not say which process to signal; only the
 *    two together bind socket → pid → boot time, and the pair is re-taken immediately before the
 *    signal. Any disagreement aborts the stop, and no harder or second signal exists (R3, R23).
 */

/** What `GET /version` answers. `activeRuns` is the only input to a restart decision (R21). */
export interface EngineIdentity {
  version: string;
  pid: number;
  startedAt: string;
  socketPath: string;
  activeRuns: number;
}

/**
 * `null` — nothing is listening (ENOENT/ECONNREFUSED, the two codes the API client already treats
 * as "not running"). `'foreign'` — something answers the socket with a body that is not this
 * engine's `/version`. `'unreachable'` — the socket accepted the connection and then said nothing
 * within the probe's timeout, which is what an engine that is still booting or wedged under load
 * looks like. It is deliberately *not* `'foreign'`: a stranger is a verdict, a timeout is a
 * question, and the manager asks it again before it answers (see `probeOrRetry`).
 */
export type ProbeResult = EngineIdentity | 'foreign' | 'unreachable' | null;

/** What `<stateDir>/engine.json` says. The engine writes it before it listens (R22). */
export interface EnginePidFile {
  pid: number;
  version: string;
  socketPath: string;
  startedAt: string;
}

export type SignalOutcome = 'signalled' | 'gone' | 'foreign';

/** A spawned child, kept (unref'ed) only so its exit can be observed (R26). */
export interface SpawnedEngine {
  pid: number;
  onExit(cb: (code: number | null) => void): void;
}

export interface SpawnSpec {
  execPath: string;
  args: string[];
  cwd: string;
  logPath: string;
  /**
   * Overrides merged onto the adapter's own sanitized environment. The adapter owns R10/R24's
   * scrubbing and the `ELECTRON_RUN_AS_NODE` it must add; the state machine only says what `PATH`
   * the login shell resolved (R20), or `undefined` to fall back to the host's own.
   */
  env: Record<string, string | undefined>;
}

export interface EngineProcessPort {
  probe(socketPath: string): Promise<ProbeResult>;
  /** R20: `$SHELL -lic 'echo $PATH'`, 5 s cap; `null` when it times out or gives nothing. */
  resolveLoginPath(): Promise<string | null>;
  /** Throws when the child reports no pid — the `no pid` failure mode the local-app runner has. */
  spawnDetached(spec: SpawnSpec): Promise<SpawnedEngine>;
  /** R11/R30: rotate BEFORE the spawn recreates the file; a no-op below the threshold. */
  rotateLog(path: string, maxBytes: number): Promise<void>;
  readPidFile(path: string): Promise<EnginePidFile | null>;
  signal(pid: number, sig: 'SIGTERM'): SignalOutcome;
  logTail(path: string, lines: number): Promise<string[]>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export type EngineState =
  | { kind: 'unknown' }
  | { kind: 'stopped' }
  | { kind: 'starting'; since: number }
  | { kind: 'running'; version: string; pid: number; adopted: boolean }
  | { kind: 'stopping'; since: number; pid: number; elapsedMs: number }
  | { kind: 'mismatch'; running: string; bundled: string; pid: number }
  | { kind: 'foreign' }
  | { kind: 'failed'; reason: string; logTail: readonly string[] };

/** Where the engine's files are. Re-read on every use, because the setting can change (D5). */
export interface EnginePaths {
  configPath: string;
  socketPath: string;
  enginePidPath: string;
  engineLogPath: string;
}

/** How to start it: the Node host, the bundle, and the directory to start it in. */
export interface EngineLaunch {
  execPath: string;
  enginePath: string;
  cwd: string;
}

/**
 * `'user'` is a person asking for this, and is never refused or delayed; `'auto'` is activation, a
 * settings change or a config save, and is what the respawn backoff exists to bound (R26).
 */
export type Trigger = 'auto' | 'user';

export interface EngineManagerOptions {
  process: EngineProcessPort;
  bundledVersion: string;
  paths: () => EnginePaths;
  launch: () => EngineLaunch;
  log: (line: string) => void;
}

/** R18: the harness that already works polls 25 ms/10 s; 100 ms is kinder to an editor. */
export const START_POLL_MS = 100;
export const START_TIMEOUT_MS = 10_000;
/** R23: the stop budget, and what happens past it. */
export const STOP_POLL_MS = 500;
export const STOP_BUDGET_MS = 45_000;
export const STOPPING_POLL_MS = 1_000;
export const STOPPING_BOUND_MS = 300_000;
/** R11: rotate at 8 MB. */
export const LOG_MAX_BYTES = 8 * 1024 * 1024;
export const TAIL_LINES = 20;
/** A timeout is retried, not believed: three attempts (2 s each, in the adapter) then `foreign`. */
export const PROBE_ATTEMPTS = 3;
export const PROBE_RETRY_GAP_MS = 200;
/** R26: three automatic retries, each behind a longer gate, then no more. */
export const RESPAWN_BACKOFF_MS: readonly number[] = [1_000, 5_000, 30_000];

/** The three lifecycle operations; the memo above is per kind, the lane is shared. */
type OperationKind = 'ensure' | 'stop' | 'restart';

function sameIdentity(a: EnginePidFile, b: EngineIdentity): boolean {
  return a.pid === b.pid && a.startedAt === b.startedAt;
}

export class EngineManager {
  private current: EngineState = { kind: 'unknown' };
  private readonly listeners = new Set<(state: EngineState) => void>();
  /**
   * The single serial lane every lifecycle operation runs in. `starting` and `stopping` used to be
   * two independent locks, which let a start interleave with a stop that had signalled but whose
   * process had not exited yet — and adopt the engine that was on its way out.
   */
  private queue: Promise<unknown> = Promise.resolve();
  /** The in-flight operation per kind, so a burst of one kind still costs one operation. */
  private readonly inFlight = new Map<OperationKind, Promise<EngineState>>();
  private child: SpawnedEngine | null = null;
  /** How many spawns we have made since the last user request; drives the backoff gate. */
  private attempts = 0;
  /** When the last spawn attempt *finished*, successfully or not. */
  private lastAttemptEndedAt: number | null = null;
  /** R20: the fallback is worth one line, not one per retry. */
  private pathFallbackLogged = false;

  constructor(private readonly opts: EngineManagerOptions) {}

  state(): EngineState {
    return this.current;
  }

  /**
   * R21: how much work a restart would cancel, straight from `GET /version`. `null` means nothing
   * answered. This is the *only* input to a restart decision: the PR-level listing the panel shows
   * describes pull requests, not the engine's own in-flight work, and cannot see a preparing stage.
   */
  async activeRuns(): Promise<number | null> {
    const probe = await this.opts.process.probe(this.opts.paths().socketPath);
    return probe === null || typeof probe === 'string' ? null : probe.activeRuns;
  }

  onStateChange(cb: (state: EngineState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /**
   * Adopt an engine that answers, or start one. Concurrent callers share one in-flight promise, so
   * a burst of triggers produces exactly one spawn (MG-C1).
   */
  ensureRunning(trigger: Trigger = 'auto'): Promise<EngineState> {
    return this.serial('ensure', () => this.runEnsure(trigger));
  }

  stop(): Promise<EngineState> {
    return this.serial('stop', () => this.runStop());
  }

  /**
   * Stop, then start. A stop that ran past its budget defers the start until the socket finally
   * goes silent (R23); a stop that could not prove ownership aborts it — the manager never spawns
   * a second engine against a live socket.
   */
  restart(trigger: Trigger = 'auto'): Promise<EngineState> {
    return this.serial('restart', () => this.runRestart(trigger));
  }

  /**
   * One operation at a time, in the order they were asked for, with the memo the burst case needs:
   * five concurrent `ensureRunning`s share one queued operation (MG-C1), while a `stop` asked for
   * during one waits its turn rather than interleaving with it.
   */
  private serial(kind: OperationKind, work: () => Promise<EngineState>): Promise<EngineState> {
    const pending = this.inFlight.get(kind);
    if (pending !== undefined) return pending;
    const run = this.enqueue(work).finally(() => {
      if (this.inFlight.get(kind) === run) this.inFlight.delete(kind);
    });
    this.inFlight.set(kind, run);
    return run;
  }

  /** Appends to the lane. A failed operation does not stall the ones behind it. */
  private enqueue(work: () => Promise<EngineState>): Promise<EngineState> {
    const run = this.queue.then(work, work);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * The restart is one lane entry, not three: it calls the operations' bodies directly, because
   * queueing them from inside the lane would wait on a turn that cannot come until it returns.
   */
  private async runRestart(trigger: Trigger): Promise<EngineState> {
    const before = await this.probeOrRetry(this.opts.paths().socketPath);
    if (before === null) return await this.runEnsure(trigger);
    const stopped = await this.runStop();
    if (stopped.kind !== 'stopped') return stopped;
    return await this.runEnsure(trigger);
  }

  private setState(state: EngineState): EngineState {
    this.current = state;
    for (const listener of [...this.listeners]) listener(state);
    return state;
  }

  private async failed(reason: string): Promise<EngineState> {
    const tail = await this.tail();
    return this.setState({ kind: 'failed', reason, logTail: tail });
  }

  private async tail(): Promise<string[]> {
    try {
      return await this.opts.process.logTail(this.opts.paths().engineLogPath, TAIL_LINES);
    } catch {
      return [];
    }
  }

  private classify(probe: EngineIdentity | null, adopted: boolean): EngineState | null {
    if (probe === null) return null;
    if (probe.version !== this.opts.bundledVersion) {
      return this.setState({
        kind: 'mismatch',
        running: probe.version,
        bundled: this.opts.bundledVersion,
        pid: probe.pid,
      });
    }
    return this.setState({ kind: 'running', version: probe.version, pid: probe.pid, adopted });
  }

  /**
   * A probe whose only answer is silence is asked again before it is believed. Three attempts (the
   * adapter caps each at 2 s) is long enough for an engine that is merely slow to boot, and short
   * enough that a genuinely wedged stranger still ends the burst; only then does it become the
   * `foreign` verdict, which is what stops a second engine being started against a live socket.
   */
  private async probeOrRetry(socketPath: string): Promise<EngineIdentity | 'foreign' | null> {
    const proc = this.opts.process;
    for (let attempt = 1; ; attempt += 1) {
      const result = await proc.probe(socketPath);
      if (result !== 'unreachable') return result;
      if (attempt >= PROBE_ATTEMPTS) {
        this.opts.log(
          `engine.probe_unreachable: ${socketPath} accepted ${PROBE_ATTEMPTS} probes and answered none; treating it as another server`,
        );
        return 'foreign';
      }
      await proc.sleep(PROBE_RETRY_GAP_MS);
    }
  }

  /**
   * Every trigger — a user's or activation's — re-probes here first, so a `foreign` the manager
   * reported earlier is never trusted as a standing fact: it is re-checked against reality.
   */
  private async runEnsure(trigger: Trigger): Promise<EngineState> {
    const paths = this.opts.paths();
    const probe = await this.probeOrRetry(paths.socketPath);
    if (probe === 'foreign') return this.setState({ kind: 'foreign' });
    const adopted = this.classify(probe, true);
    // An engine that answers is not a failed start, whoever started it: the backoff bounds
    // failures to come up, and nothing here has failed. (`foreign` is not that answer — after
    // `probeOrRetry` it also stands for three probes that said nothing at all, and a silence
    // must not clear a gate that failed spawns earned.)
    if (adopted !== null) {
      this.attempts = 0;
      return adopted;
    }
    if (trigger === 'user') this.attempts = 0;
    const refusal = this.backoffRefusal(trigger);
    if (refusal !== null) {
      this.opts.log(refusal);
      return this.current;
    }
    return await this.spawnAndWait(paths);
  }

  /**
   * R26. The gate is measured from the end of the previous attempt, which is both what makes a
   * spawn that failed *slowly* (the 10 s socket timeout) still hold the line for a second, and
   * what the 1 s / 5 s / 30 s sequence is written against.
   */
  private backoffRefusal(trigger: Trigger): string | null {
    if (trigger === 'user' || this.attempts === 0 || this.lastAttemptEndedAt === null) return null;
    if (this.attempts > RESPAWN_BACKOFF_MS.length) {
      return `engine.respawn_exhausted: ${this.attempts} attempts have failed; start it yourself when it is fixed`;
    }
    const gate = RESPAWN_BACKOFF_MS[this.attempts - 1];
    const waited = this.opts.process.now() - this.lastAttemptEndedAt;
    if (waited >= gate) return null;
    return `engine.respawn_deferred: ${gate - waited}ms left of the ${gate}ms backoff after ${this.attempts} attempt(s)`;
  }

  private async spawnAndWait(paths: EnginePaths): Promise<EngineState> {
    const proc = this.opts.process;
    this.setState({ kind: 'starting', since: proc.now() });
    const loginPath = await proc.resolveLoginPath();
    if (loginPath === null && !this.pathFallbackLogged) {
      this.pathFallbackLogged = true;
      this.opts.log(
        "engine.path_fallback: the login shell did not answer with a PATH; using this process's own",
      );
    }
    if (loginPath !== null) this.pathFallbackLogged = false;
    await proc.rotateLog(paths.engineLogPath, LOG_MAX_BYTES);

    const launch = this.opts.launch();
    this.attempts += 1;
    let child: SpawnedEngine;
    try {
      child = await proc.spawnDetached({
        execPath: launch.execPath,
        args: [launch.enginePath, 'serve', '--config', paths.configPath],
        cwd: launch.cwd,
        logPath: paths.engineLogPath,
        env: { PATH: loginPath ?? undefined },
      });
    } catch (err) {
      this.lastAttemptEndedAt = proc.now();
      return await this.failed(`the engine could not be started: ${messageOf(err)}`);
    }
    if (!Number.isInteger(child.pid) || child.pid <= 0) {
      this.lastAttemptEndedAt = proc.now();
      return await this.failed('the engine could not be started: no pid');
    }
    this.child = child;
    let exited = false;
    child.onExit((code) => {
      exited = true;
      void this.handleChildExit(child, code);
    });

    const deadline = proc.now() + START_TIMEOUT_MS;
    for (;;) {
      await proc.sleep(START_POLL_MS);
      // The child died before the socket came up: `handleChildExit` has already said so, and
      // polling on would only replace its reason with a less useful timeout (R26).
      if (exited) {
        this.lastAttemptEndedAt = proc.now();
        return this.current;
      }
      const probe = await proc.probe(paths.socketPath);
      // Neither a stranger nor a silence ends the wait: the socket we are waiting on may still be
      // the one our own child is about to answer on.
      const state = typeof probe === 'string' ? null : this.classify(probe, false);
      if (state !== null) {
        this.lastAttemptEndedAt = proc.now();
        // The engine came up. R26's gate exists to bound spawns that *fail*; counting a
        // successful one would make the next automatic start (R21's silent restart, a config
        // save) wait out a backoff it never earned — and three of them exhaust it for good.
        this.attempts = 0;
        return state;
      }
      if (proc.now() >= deadline) {
        this.lastAttemptEndedAt = proc.now();
        return await this.failed(
          `the engine did not answer on ${paths.socketPath} within ${START_TIMEOUT_MS}ms`,
        );
      }
    }
  }

  /** R26: an exit while we believe it is running is a failure now, not at the next poll. */
  private async handleChildExit(child: SpawnedEngine, code: number | null): Promise<void> {
    if (this.child !== child) return;
    this.child = null;
    if (this.current.kind !== 'running' && this.current.kind !== 'starting') return;
    this.lastAttemptEndedAt = this.opts.process.now();
    await this.failed(`the engine exited with code ${code === null ? 'unknown' : String(code)}`);
  }

  private async runStop(): Promise<EngineState> {
    const proc = this.opts.process;
    const paths = this.opts.paths();
    const first = await this.proof(paths);
    if (typeof first === 'string') return await this.failed(first);

    // R29: the proof is re-taken immediately before the signal, and must still name the same
    // process *and* the same boot — a reused pid has a different `startedAt`.
    const second = await this.proof(paths);
    if (typeof second === 'string') return await this.failed(second);
    if (second.pid !== first.pid || second.startedAt !== first.startedAt) {
      return await this.failed(
        'the engine changed between the ownership proof and the signal; nothing was signalled',
      );
    }

    const outcome = proc.signal(second.pid, 'SIGTERM');
    if (outcome === 'gone') return this.setState({ kind: 'stopped' });
    if (outcome === 'foreign') {
      return await this.failed(`pid ${second.pid} is not ours to signal; nothing was stopped`);
    }

    const since = proc.now();
    const budget = since + STOP_BUDGET_MS;
    for (;;) {
      await proc.sleep(STOP_POLL_MS);
      if ((await proc.probe(paths.socketPath)) === null) return this.setState({ kind: 'stopped' });
      if (proc.now() >= budget) break;
    }
    return await this.waitOutStop(paths, since, second.pid);
  }

  /**
   * R23: past the budget the manager reports `stopping` and keeps *watching*. It never escalates —
   * no second `SIGTERM`, nothing harder — and it stops at a bound so it cannot poll forever.
   */
  private async waitOutStop(
    paths: EnginePaths,
    since: number,
    pid: number,
  ): Promise<EngineState> {
    const proc = this.opts.process;
    const bound = proc.now() + STOPPING_BOUND_MS;
    this.setState({ kind: 'stopping', since, pid, elapsedMs: proc.now() - since });
    for (;;) {
      await proc.sleep(STOPPING_POLL_MS);
      if ((await proc.probe(paths.socketPath)) === null) return this.setState({ kind: 'stopped' });
      if (proc.now() >= bound) {
        const minutes = Math.round((proc.now() - since) / 60_000);
        return await this.failed(
          `the engine is still answering ${minutes} minutes after SIGTERM; see ${paths.engineLogPath}`,
        );
      }
      this.setState({ kind: 'stopping', since, pid, elapsedMs: proc.now() - since });
    }
  }

  /** The two-part proof, or the reason it failed. Never signals; never has a side effect. */
  private async proof(paths: EnginePaths): Promise<EnginePidFile | string> {
    const proc = this.opts.process;
    const recorded = await proc.readPidFile(paths.enginePidPath);
    if (recorded === null) {
      return `no engine identity file at ${paths.enginePidPath}; nothing was signalled`;
    }
    if (recorded.socketPath !== paths.socketPath) {
      return `${paths.enginePidPath} names another socket (${recorded.socketPath}); nothing was signalled`;
    }
    const probe = await proc.probe(paths.socketPath);
    if (probe === null) {
      return `nothing answered on ${paths.socketPath}; nothing was signalled`;
    }
    if (probe === 'foreign') {
      return `another server answers on ${paths.socketPath}; nothing was signalled`;
    }
    if (probe === 'unreachable') {
      return `${paths.socketPath} did not answer in time, so nothing on it is provably ours; nothing was signalled`;
    }
    if (!sameIdentity(recorded, probe)) {
      return `${paths.enginePidPath} (pid ${recorded.pid}) and the engine on the socket (pid ${probe.pid}) disagree; nothing was signalled`;
    }
    return recorded;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
