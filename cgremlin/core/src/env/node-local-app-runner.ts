import { execFile, spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import type { RequestOptions } from 'node:http';
import type {
  ExecResult,
  HealthResult,
  LocalAppProcess,
  LocalAppRunner,
  LocalAppSpec,
  LocalAppStopResult,
} from './local-app-runner';

const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const DEFAULT_EXEC_TIMEOUT_MS = 600_000;
const STOP_GRACE_MS = 5_000;
const STOP_POLL_INTERVAL_MS = 200;
/** How long the port may stay bound after the group is gone before we look at who holds it. */
const PORT_RELEASE_MS = 1_000;

function wrap(command: string, nodeVersion?: string): string {
  return nodeVersion === undefined
    ? command
    : `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" 2>/dev/null; nvm use ${nodeVersion} >/dev/null 2>&1 || exit 78; ${command}`;
}

/** Resolves after `ms`, or as soon as `signal` aborts — whichever comes first (W4). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error;
}

export class NodeLocalAppRunner implements LocalAppRunner {
  async exec(
    command: string,
    opts: { cwd: string; nodeVersion?: string; timeoutMs?: number; logPath?: string },
  ): Promise<ExecResult> {
    const result = await new Promise<ExecResult>((resolve) => {
      execFile(
        'bash',
        ['-lc', wrap(command, opts.nodeVersion)],
        {
          cwd: opts.cwd,
          timeout: opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
          maxBuffer: MAX_BUFFER_BYTES,
        },
        (error, stdout, stderr) => {
          let code: number | null = 0;
          if (error) {
            code = isErrnoException(error) && typeof error.code === 'number' ? error.code : 1;
          }
          resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
        },
      );
    });
    if (opts.logPath) {
      await this.appendToLog(opts.logPath, result.stdout + result.stderr);
    }
    return result;
  }

  async portListenerPid(port: number): Promise<number | null> {
    const result = await this.runRaw('lsof', ['-t', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN']);
    if (result.code !== 0) return null;
    const first = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '');
    if (!first) return null;
    const pid = Number.parseInt(first, 10);
    return Number.isNaN(pid) ? null : pid;
  }

  async pgidOf(pid: number): Promise<number | null> {
    const result = await this.runRaw('ps', ['-o', 'pgid=', '-p', String(pid)]);
    if (result.code !== 0) return null;
    const trimmed = result.stdout.trim();
    if (!trimmed) return null;
    const pgid = Number.parseInt(trimmed, 10);
    return Number.isNaN(pgid) ? null : pgid;
  }

  async start(spec: LocalAppSpec): Promise<LocalAppProcess> {
    const fd = openSync(spec.logPath, spec.appendLog ? 'a' : 'w');
    const child = spawn('bash', ['-lc', wrap(spec.command, spec.nodeVersion)], {
      cwd: spec.cwd,
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    child.unref();
    closeSync(fd);
    if (child.pid === undefined) {
      throw new Error('failed to spawn local app process: no pid');
    }
    return { pid: child.pid, pgid: child.pid, startedAt: new Date().toISOString() };
  }

  async healthcheck(
    url: string,
    opts: {
      timeoutMs: number;
      intervalMs: number;
      insecureTls: boolean;
      proc?: LocalAppProcess;
      signal?: AbortSignal;
    },
  ): Promise<HealthResult> {
    const deadline = Date.now() + opts.timeoutMs;
    let lastReason: string | null = null;
    for (;;) {
      // W4: checked between polls, so a shutdown mid-wait is honoured in one
      // interval rather than after the full timeout.
      if (opts.signal?.aborted === true) {
        return { ok: false, status: null, exited: false, reason: 'aborted' };
      }
      if (opts.proc && !(await this.isAlive(opts.proc))) {
        return {
          ok: false,
          status: null,
          exited: true,
          reason: 'dev command exited before the port answered',
        };
      }
      const attempt = await this.attemptRequest(url, opts.intervalMs, opts.insecureTls);
      if (attempt.ok) {
        return { ok: true, status: attempt.status, exited: false, reason: null };
      }
      lastReason = attempt.reason;
      if (Date.now() >= deadline) {
        return {
          ok: false,
          status: null,
          exited: false,
          reason: lastReason ?? `did not come up within ${opts.timeoutMs}ms`,
        };
      }
      const remaining = deadline - Date.now();
      await sleep(Math.max(0, Math.min(opts.intervalMs, remaining)), opts.signal);
    }
  }

  async isAlive(proc: LocalAppProcess): Promise<boolean> {
    try {
      process.kill(-proc.pgid, 0);
      return true;
    } catch (err) {
      if (!isErrnoException(err)) return true;
      // ESRCH: nothing there. EPERM: the pgid was reused by a group we do not
      // own — not our process, so not alive as far as this engine is concerned
      // (and we must never go on to signal it).
      return err.code !== 'ESRCH' && err.code !== 'EPERM';
    }
  }

  async stop(proc: LocalAppProcess, opts: { port: number }): Promise<LocalAppStopResult> {
    this.killGroup(proc.pgid, 'SIGTERM');
    const deadline = Date.now() + STOP_GRACE_MS;
    while (Date.now() < deadline && (await this.isAlive(proc))) {
      await sleep(STOP_POLL_INTERVAL_MS);
    }
    // A dev command that traps SIGTERM only lets go of the port here.
    this.killGroup(proc.pgid, 'SIGKILL');
    let listenerPid = await this.waitForPortRelease(opts.port);
    if (listenerPid === null) return { freed: true };

    // R6: the lingering listener is only ours to kill when it is the process
    // we recorded or sits in the group we just signalled. Anything else is a
    // foreign process on the port — report it, never signal it.
    const listenerPgid = await this.pgidOf(listenerPid);
    if (listenerPid !== proc.pid && listenerPgid !== proc.pgid) {
      return { freed: false, foreignListener: listenerPid };
    }
    this.killPid(listenerPid, 'SIGTERM');
    listenerPid = await this.waitForPortRelease(opts.port);
    if (listenerPid === null) return { freed: true };
    this.killPid(listenerPid, 'SIGKILL');
    listenerPid = await this.waitForPortRelease(opts.port);
    return listenerPid === null ? { freed: true } : { freed: false, foreignListener: listenerPid };
  }

  /** Polls until nothing listens on `port`, or ~PORT_RELEASE_MS elapses; returns the holder or null. */
  private async waitForPortRelease(port: number): Promise<number | null> {
    const deadline = Date.now() + PORT_RELEASE_MS;
    for (;;) {
      const pid = await this.portListenerPid(port);
      if (pid === null) return null;
      if (Date.now() >= deadline) return pid;
      await sleep(STOP_POLL_INTERVAL_MS);
    }
  }

  async tailLog(logPath: string, lines: number): Promise<string> {
    return this.sliceLog(logPath, lines, 'tail');
  }

  async headLog(logPath: string, lines: number): Promise<string> {
    return this.sliceLog(logPath, lines, 'head');
  }

  private killGroup(pgid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pgid, signal);
    } catch (err) {
      if (!isErrnoException(err) || err.code !== 'ESRCH') throw err;
    }
  }

  private killPid(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(pid, signal);
    } catch (err) {
      if (!isErrnoException(err) || err.code !== 'ESRCH') throw err;
    }
  }

  private async sliceLog(logPath: string, lines: number, mode: 'head' | 'tail'): Promise<string> {
    let content: string;
    try {
      content = await readFile(logPath, 'utf8');
    } catch {
      return '';
    }
    let allLines = content.split('\n');
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
      allLines = allLines.slice(0, -1);
    }
    const picked = mode === 'head' ? allLines.slice(0, lines) : allLines.slice(-lines);
    return picked.join('\n');
  }

  private async appendToLog(logPath: string, chunk: string): Promise<void> {
    await appendFile(logPath, chunk);
  }

  private runRaw(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(cmd, args, { maxBuffer: MAX_BUFFER_BYTES }, (error, stdout, stderr) => {
        let code = 0;
        if (error) {
          code = isErrnoException(error) && typeof error.code === 'number' ? error.code : 1;
        }
        resolve({ code, stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '' });
      });
    });
  }

  private attemptRequest(
    url: string,
    timeoutMs: number,
    insecureTls: boolean,
  ): Promise<{ ok: boolean; status: number | null; reason: string | null }> {
    return new Promise((resolve) => {
      let parsed: URL;
      try {
        parsed = new URL(url.endsWith('/') ? url : `${url}/`);
      } catch (err) {
        resolve({ ok: false, status: null, reason: (err as Error).message });
        return;
      }
      const isHttps = parsed.protocol === 'https:';
      const client = isHttps ? https : http;
      const options: RequestOptions = { timeout: timeoutMs };
      if (isHttps) {
        (options as https.RequestOptions).rejectUnauthorized = !insecureTls;
      }
      let settled = false;
      const finish = (result: { ok: boolean; status: number | null; reason: string | null }) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const req = client.get(parsed, options, (res) => {
        res.resume();
        const status = res.statusCode ?? null;
        finish({
          ok: status !== null && status >= 200 && status < 300,
          status,
          reason: status !== null && status >= 200 && status < 300 ? null : `status ${status}`,
        });
      });
      req.on('timeout', () => {
        req.destroy();
        finish({ ok: false, status: null, reason: 'request timed out' });
      });
      req.on('error', (err) => {
        finish({ ok: false, status: null, reason: err.message });
      });
    });
  }
}
