import type {
  ExecResult,
  HealthResult,
  LocalAppProcess,
  LocalAppRunner,
  LocalAppSpec,
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
  private readonly pgidByPid = new Map<number, number>();
  private readonly callLog: string[] | undefined;

  private portListener: number | null = null;
  private alive = false;
  private startedProcess: LocalAppProcess = DEFAULT_STARTED_PROCESS;

  constructor(options: FakeLocalAppRunnerOptions = {}) {
    this.callLog = options.callLog;
  }

  queueExec(response: ExecResult | Error): void {
    this.execResponses.push(response);
  }

  queueHealth(response: HealthResult | Error): void {
    this.healthResponses.push(response);
  }

  setPortListener(pid: number | null): void {
    this.portListener = pid;
  }

  setAlive(alive: boolean): void {
    this.alive = alive;
  }

  setStartResult(proc: LocalAppProcess): void {
    this.startedProcess = proc;
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
    _opts: { timeoutMs: number; intervalMs: number; insecureTls: boolean; proc?: LocalAppProcess },
  ): Promise<HealthResult> {
    const next = this.healthResponses.shift();
    if (next instanceof Error) {
      throw next;
    }
    return next ?? { ok: true, status: 200, reason: null, exited: false };
  }

  async isAlive(_proc: LocalAppProcess): Promise<boolean> {
    return this.alive;
  }

  async stop(proc: LocalAppProcess, opts: { port: number }): Promise<void> {
    this.stopCalls.push({ proc, opts });
    this.portListener = null;
    this.alive = false;
    this.callLog?.push('local.stop');
  }

  async tailLog(_logPath: string, _lines: number): Promise<string> {
    return '';
  }

  async headLog(_logPath: string, _lines: number): Promise<string> {
    return '';
  }
}
