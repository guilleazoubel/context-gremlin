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

/**
 * What `stop` achieved. `freed: false` means the port is still held by a
 * process that is not in the group we stopped (R6: we never signal it) —
 * `foreignListener` is its pid, for the caller to surface.
 */
export interface LocalAppStopResult {
  freed: boolean;
  foreignListener?: number;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Phase 16 — one GET whose BODY is the point (the QA version endpoint), as
 * opposed to `healthcheck`, which polls and reads only the status code.
 * `body` is null when nothing came back; `reason` is set whenever the request
 * did not produce a 2xx body.
 */
export interface TextResult {
  status: number | null;
  body: string | null;
  reason: string | null;
}

export interface LocalAppRunner {
  exec(
    command: string,
    opts: { cwd: string; nodeVersion?: string; timeoutMs?: number; logPath?: string },
  ): Promise<ExecResult>;
  portListenerPid(port: number): Promise<number | null>;
  pgidOf(pid: number): Promise<number | null>;
  start(spec: LocalAppSpec): Promise<LocalAppProcess>;
  /** Polls the URL until 2xx, the timeout, `proc` exits, or `signal` aborts — whichever
   *  comes first; `exited: true` means the dev command died before the port ever
   *  answered (R11). W4: `signal` is checked between polls so a shutdown does not
   *  have to wait out the whole healthcheck timeout. */
  healthcheck(
    url: string,
    opts: {
      timeoutMs: number;
      intervalMs: number;
      insecureTls: boolean;
      proc?: LocalAppProcess;
      signal?: AbortSignal;
    },
  ): Promise<HealthResult>;
  /**
   * ONE GET, no polling, body capped — what `EnvironmentService.qaVersion`
   * reads the deployed build sha out of. **Optional**: a harness that only
   * exercises the local app need not implement it, and a caller that finds it
   * missing degrades exactly as it degrades on an unreachable endpoint.
   */
  getText?(url: string, opts: { timeoutMs: number }): Promise<TextResult>;
  isAlive(proc: LocalAppProcess): Promise<boolean>;
  /** R6: kills only `proc`'s own group; a lingering listener from another group is reported, never killed. */
  stop(proc: LocalAppProcess, opts: { port: number }): Promise<LocalAppStopResult>;
  tailLog(logPath: string, lines: number): Promise<string>;
  headLog(logPath: string, lines: number): Promise<string>;
}

export class LocalAppPortBusyError extends Error {
  readonly port: number;
  readonly pid: number;
  readonly ours: boolean;
  readonly sessionId: string | null;

  constructor(port: number, pid: number, ours: boolean, sessionId: string | null = null) {
    super(
      ours
        ? `port ${port} is held by a local app this engine started (pid ${pid}, session ${sessionId ?? '?'}) — run 'cgremlin-core local stop' to release it`
        : `port ${port} is held by pid ${pid}, which the engine did not start — it will not be killed; stop it yourself or change localApp.port`,
    );
    this.name = 'LocalAppPortBusyError';
    this.port = port;
    this.pid = pid;
    this.ours = ours;
    this.sessionId = sessionId;
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
