export interface LocalAppSpec {
  cwd: string;
  command: string;
  nodeVersion?: string;
  logPath: string;
  appendLog?: boolean;
}

export interface LocalAppProcess {
  pid: number;
  pgid: number;
  startedAt: string;
}

export interface HealthResult {
  ok: boolean;
  status: number | null;
  reason: string | null;
  exited: boolean;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface LocalAppRunner {
  exec(
    command: string,
    opts: { cwd: string; nodeVersion?: string; timeoutMs?: number; logPath?: string },
  ): Promise<ExecResult>;
  portListenerPid(port: number): Promise<number | null>;
  pgidOf(pid: number): Promise<number | null>;
  start(spec: LocalAppSpec): Promise<LocalAppProcess>;
  /** Polls the URL until 2xx, the timeout, or `proc` exits — whichever comes first;
   *  `exited: true` means the dev command died before the port ever answered (R11). */
  healthcheck(
    url: string,
    opts: { timeoutMs: number; intervalMs: number; insecureTls: boolean; proc?: LocalAppProcess },
  ): Promise<HealthResult>;
  isAlive(proc: LocalAppProcess): Promise<boolean>;
  stop(proc: LocalAppProcess, opts: { port: number }): Promise<void>;
  tailLog(logPath: string, lines: number): Promise<string>;
  headLog(logPath: string, lines: number): Promise<string>;
}

export class LocalAppPortBusyError extends Error {
  readonly port: number;
  readonly pid: number;
  readonly ours: boolean;

  constructor(port: number, pid: number, ours: boolean) {
    super(
      ours
        ? `port ${port} is held by a local app this engine started (pid ${pid}) — run 'cgremlin-core local stop' to release it`
        : `port ${port} is held by pid ${pid}, which the engine did not start — it will not be killed; stop it yourself or change localApp.port`,
    );
    this.name = 'LocalAppPortBusyError';
    this.port = port;
    this.pid = pid;
    this.ours = ours;
  }
}

export class LocalAppPrereqError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalAppPrereqError';
  }
}

export class LocalAppUnhealthyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalAppUnhealthyError';
  }
}

export type LocalAppSetupStep = 'vercel link' | 'vercel env pull' | 'pnpm install' | 'generated dir' | 'env file';

export class LocalAppSetupError extends Error {
  readonly step: LocalAppSetupStep | undefined;

  constructor(message: string, step?: LocalAppSetupStep) {
    super(message);
    this.name = 'LocalAppSetupError';
    this.step = step;
  }
}
