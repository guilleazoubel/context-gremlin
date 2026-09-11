/**
 * A recording `EngineProcessPort` on a fake clock.
 *
 * Everything the engine manager can do to a machine — spawn a daemon, signal a pid — goes through
 * this port, so this fake is where "it never did that" is provable. Every call lands in one
 * ordered log (`calls`), because several of the rules under test are about *order*: rotate before
 * spawn (R30), and prove before signal (R29).
 */
import type {
  EngineIdentity,
  EnginePidFile,
  EngineProcessPort,
  ProbeResult,
  SignalOutcome,
  SpawnSpec,
  SpawnedEngine,
} from '../../src/engine/manager';

interface Timer {
  dueAt: number;
  resolve: () => void;
}

export function identity(over: Partial<EngineIdentity> = {}): EngineIdentity {
  return {
    version: '0.0.1',
    buildId: 'aaaaaaaaaaaaaaaa',
    pid: 4242,
    startedAt: '2026-09-10T10:00:00.000Z',
    socketPath: '/tmp/cg/engine.sock',
    activeRuns: 0,
    ...over,
  };
}

export function pidFile(over: Partial<EnginePidFile> = {}): EnginePidFile {
  return {
    pid: 4242,
    version: '0.0.1',
    socketPath: '/tmp/cg/engine.sock',
    startedAt: '2026-09-10T10:00:00.000Z',
    ...over,
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export class FakeEngineProcess implements EngineProcessPort {
  readonly calls: { kind: string; args: unknown[] }[] = [];
  readonly spawns: SpawnSpec[] = [];
  readonly signals: { pid: number; sig: string }[] = [];
  readonly rotations: { path: string; maxBytes: number }[] = [];

  /** Answered by `probe`, in order; the last one repeats. */
  probes: ProbeResult[] = [null];
  /**
   * What the socket answers once something has been spawned. Set it and the queue above is only
   * consulted before the first spawn — which is how "nothing there, start one, now it answers"
   * reads in a test without counting probes.
   */
  spawnedAnswer: ProbeResult | undefined;
  /** Answered by `readPidFile`, in order; the last one repeats. */
  pidFiles: (EnginePidFile | null)[] = [null];
  loginPath: string | null = '/login/bin:/usr/bin';
  signalOutcome: SignalOutcome = 'signalled';
  tail: string[] = ['engine.log line'];
  /** `null` makes `spawnDetached` throw the way a child with no pid does. */
  nextPid: number | null = 9001;
  spawnError: Error | null = null;

  private clock = 0;
  private readonly timers: Timer[] = [];
  private readonly exitListeners: ((code: number | null) => void)[] = [];

  private record(kind: string, ...args: unknown[]): void {
    this.calls.push({ kind, args });
  }

  kinds(): string[] {
    return this.calls.map((c) => c.kind);
  }

  /** The call order with the polling noise removed, which is what the ordering rules are about. */
  order(): string[] {
    return this.kinds().filter((k) => k !== 'sleep' && k !== 'now');
  }

  private next<T>(queue: T[]): T {
    return queue.length > 1 ? (queue.shift() as T) : queue[0];
  }

  async probe(socketPath: string): Promise<ProbeResult> {
    this.record('probe', socketPath);
    if (this.spawnedAnswer !== undefined && this.spawns.length > 0) return this.spawnedAnswer;
    return this.next(this.probes);
  }

  async resolveLoginPath(): Promise<string | null> {
    this.record('resolveLoginPath');
    return this.loginPath;
  }

  async spawnDetached(spec: SpawnSpec): Promise<SpawnedEngine> {
    this.record('spawnDetached', spec);
    this.spawns.push(spec);
    if (this.spawnError !== null) throw this.spawnError;
    if (this.nextPid === null) throw new Error('no pid');
    const pid = this.nextPid;
    return {
      pid,
      onExit: (cb) => this.exitListeners.push(cb),
    };
  }

  /** Simulates the child dying (R26). */
  async exit(code: number | null): Promise<void> {
    for (const cb of [...this.exitListeners]) cb(code);
    await flush();
  }

  async rotateLog(path: string, maxBytes: number): Promise<void> {
    this.record('rotateLog', path, maxBytes);
    this.rotations.push({ path, maxBytes });
  }

  async readPidFile(path: string): Promise<EnginePidFile | null> {
    this.record('readPidFile', path);
    return this.next(this.pidFiles);
  }

  signal(pid: number, sig: 'SIGTERM'): SignalOutcome {
    this.record('signal', pid, sig);
    this.signals.push({ pid, sig });
    return this.signalOutcome;
  }

  async logTail(path: string, lines: number): Promise<string[]> {
    this.record('logTail', path, lines);
    return [...this.tail];
  }

  sleep(ms: number): Promise<void> {
    this.record('sleep', ms);
    return new Promise<void>((resolve) => this.timers.push({ dueAt: this.clock + ms, resolve }));
  }

  now(): number {
    return this.clock;
  }

  /** Moves the fake clock, letting each woken continuation run before the next tick. */
  async advance(ms: number): Promise<void> {
    // Let whatever is mid-flight reach its next `sleep` before the clock moves under it.
    await flush();
    await flush();
    const target = this.clock + ms;
    for (;;) {
      const due = this.timers
        .filter((t) => t.dueAt <= target)
        .sort((a, b) => a.dueAt - b.dueAt)[0];
      if (due === undefined) break;
      this.timers.splice(this.timers.indexOf(due), 1);
      this.clock = due.dueAt;
      due.resolve();
      await flush();
      await flush();
    }
    this.clock = target;
    await flush();
  }

  /** Moves the clock with nothing waiting on it — for the backoff gates. */
  set(ms: number): void {
    this.clock = ms;
  }
}
