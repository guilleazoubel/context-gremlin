import type {
  ExecResult,
  HealthResult,
  TextResult,
  LocalAppProcess,
  LocalAppRunner,
  LocalAppSpec,
  LocalAppStopResult,
} from '../../src/env/local-app-runner';

const DEFAULT_STARTED_PROCESS: LocalAppProcess = {
  pid: 1234,
  pgid: 1234,
  startedAt: '2020-01-01T00:00:00.000Z',
};

export interface FakeLocalAppRunnerOptions {
  /** Shared ordered call log; 'local.start' / 'local.stop' are appended to it in order. */
  callLog?: string[];
}

export class FakeLocalAppRunner implements LocalAppRunner {
  readonly execCalls: Array<{
    command: string;
    opts: { cwd: string; nodeVersion?: string; timeoutMs?: number; logPath?: string };
  }> = [];
  readonly startCalls: LocalAppSpec[] = [];
  readonly stopCalls: Array<{ proc: LocalAppProcess; opts: { port: number } }> = [];

  private readonly execResponses: Array<ExecResult | Error> = [];
  private readonly healthResponses: Array<HealthResult | Error> = [];
  private readonly textResponses: Array<TextResult | Error> = [];
  /** Every `getText` the service made — a test asserts the URL it built. */
  readonly textCalls: Array<{ url: string; opts: { timeoutMs: number } }> = [];
  /** How many times `healthcheck` was called — lets a test assert "no network call happened". */
  healthCallCount = 0;
  private readonly pgidByPid = new Map<number, number>();
  private readonly callLog: string[] | undefined;

  private portListener: number | null = null;
  private logTail = '';
  private logHead = '';
  private alive = false;
  private startedProcess: LocalAppProcess = DEFAULT_STARTED_PROCESS;
  private stopResult: LocalAppStopResult = { freed: true };
  private deferredHealth: {
    entered: () => void;
    release?: (result: HealthResult) => void;
  } | null = null;

  constructor(options: FakeLocalAppRunnerOptions = {}) {
    this.callLog = options.callLog;
  }

  queueExec(response: ExecResult | Error): void {
    this.execResponses.push(response);
  }

  queueHealth(response: HealthResult | Error): void {
    this.healthResponses.push(response);
  }

  /** Phase 16: what the next `getText` (the QA version endpoint) answers. */
  queueText(response: TextResult | Error): void {
    this.textResponses.push(response);
  }

  async getText(url: string, opts: { timeoutMs: number }): Promise<TextResult> {
    this.textCalls.push({ url, opts });
    const next = this.textResponses.shift();
    if (next instanceof Error) throw next;
    return next ?? { status: 200, body: '', reason: null };
  }

  /**
   * Arms the next `healthcheck()` to hang — as a real one does while it polls —
   * until `release(...)` is called or the abort signal it was handed fires.
   * `entered` resolves once the healthcheck has actually been called.
   */
  deferHealth(): { entered: Promise<void>; release: (result: HealthResult) => void } {
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const handle: { entered: () => void; release?: (result: HealthResult) => void } = {
      entered: enteredResolve,
    };
    this.deferredHealth = handle;
    return { entered, release: (result) => handle.release?.(result) };
  }

  setPortListener(pid: number | null): void {
    this.portListener = pid;
  }

  setAlive(alive: boolean): void {
    this.alive = alive;
  }

  /** What `stop` reports — e.g. `{ freed: false, foreignListener: 9999 }` (R6). */
  setStopResult(result: LocalAppStopResult): void {
    this.stopResult = result;
  }

  setStartResult(proc: LocalAppProcess): void {
    this.startedProcess = proc;
  }

  /** What `tailLog` hands back — e.g. a line carrying a bypass URL, to prove redaction. */
  setLogTail(text: string): void {
    this.logTail = text;
  }

  setLogHead(text: string): void {
    this.logHead = text;
  }

  setPgid(pid: number, pgid: number): void {
    this.pgidByPid.set(pid, pgid);
  }

  async exec(
    command: string,
    opts: { cwd: string; nodeVersion?: string; timeoutMs?: number; logPath?: string },
  ): Promise<ExecResult> {
    this.execCalls.push({ command, opts });
    const next = this.execResponses.shift();
    if (next instanceof Error) {
      throw next;
    }
    return next ?? { code: 0, stdout: '', stderr: '' };
  }

  async portListenerPid(_port: number): Promise<number | null> {
    return this.portListener;
  }

  async pgidOf(pid: number): Promise<number | null> {
    return this.pgidByPid.get(pid) ?? pid;
  }

  async start(spec: LocalAppSpec): Promise<LocalAppProcess> {
    this.startCalls.push(spec);
    this.portListener = this.startedProcess.pid;
    this.alive = true;
    this.callLog?.push('local.start');
    return this.startedProcess;
  }

  async healthcheck(
    _url: string,
    _opts: {
      timeoutMs: number;
      intervalMs: number;
      insecureTls: boolean;
      proc?: LocalAppProcess;
      signal?: AbortSignal;
    },
  ): Promise<HealthResult> {
    this.healthCallCount += 1;
    const deferred = this.deferredHealth;
    if (deferred !== null) {
      this.deferredHealth = null;
      this.callLog?.push('local.healthcheck');
      const signal = _opts.signal;
      return new Promise<HealthResult>((resolve) => {
        const aborted = (): void =>
          resolve({ ok: false, status: null, reason: 'aborted', exited: false });
        deferred.release = resolve;
        if (signal?.aborted === true) aborted();
        else signal?.addEventListener('abort', aborted, { once: true });
        deferred.entered();
      });
    }
    const next = this.healthResponses.shift();
    if (next instanceof Error) {
      throw next;
    }
    return next ?? { ok: true, status: 200, reason: null, exited: false };
  }

  async isAlive(_proc: LocalAppProcess): Promise<boolean> {
    return this.alive;
  }

  async stop(proc: LocalAppProcess, opts: { port: number }): Promise<LocalAppStopResult> {
    this.stopCalls.push({ proc, opts });
    this.alive = false;
    this.callLog?.push('local.stop');
    if (this.stopResult.freed) this.portListener = null;
    return this.stopResult;
  }

  async tailLog(_logPath: string, _lines: number): Promise<string> {
    return this.logTail;
  }

  async headLog(_logPath: string, _lines: number): Promise<string> {
    return this.logHead;
  }
}
