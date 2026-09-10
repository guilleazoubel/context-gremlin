/**
 * The Node half of {@link EngineProcessPort} — the only place in the extension that opens a
 * socket, reads the identity file, spawns a process or signals one.
 *
 * It is deliberately thin and deliberately boring: the interesting decisions all live in
 * `manager.ts`, which is why they can be tested on a fake clock. What lives here is the machinery
 * copied from the engine's own local-app runner (`core/src/env/node-local-app-runner.ts`) —
 * `openSync` → detached `spawn` → `unref` → `closeSync`, and the `ESRCH`/`EPERM` classification
 * that is the reason a stop can never escalate against a stranger.
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import type {
  EngineIdentity,
  EnginePidFile,
  EngineProcessPort,
  ProbeResult,
  SignalOutcome,
  SpawnSpec,
  SpawnedEngine,
} from './manager';

/** R20: long enough for a pathological profile, short enough not to hang activation. */
export const LOGIN_PATH_TIMEOUT_MS = 5_000;
/** A probe that neither answers nor fails is not this engine answering. */
export const PROBE_TIMEOUT_MS = 2_000;

/** The two codes the API client already reads as "nothing is listening" (`core-client.ts`). */
const OFFLINE_CODES = new Set(['ENOENT', 'ECONNREFUSED']);

export interface NodeEngineProcessOptions {
  /** The environment the child inherits, before R10/R24's scrubbing. Injectable for tests. */
  env?: NodeJS.ProcessEnv;
  /** R20's login shell. Defaults to `$SHELL`. */
  shell?: string;
  loginPathTimeoutMs?: number;
  probeTimeoutMs?: number;
}

function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}

function asIdentity(body: unknown): EngineIdentity | null {
  if (body === null || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.version !== 'string' || typeof b.pid !== 'number') return null;
  if (typeof b.startedAt !== 'string' || typeof b.socketPath !== 'string') return null;
  if (typeof b.activeRuns !== 'number') return null;
  return {
    version: b.version,
    pid: b.pid,
    startedAt: b.startedAt,
    socketPath: b.socketPath,
    activeRuns: b.activeRuns,
  };
}

export function parsePidFile(text: string): EnginePidFile | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (body === null || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (typeof b.pid !== 'number' || typeof b.version !== 'string') return null;
  if (typeof b.socketPath !== 'string' || typeof b.startedAt !== 'string') return null;
  return { pid: b.pid, version: b.version, socketPath: b.socketPath, startedAt: b.startedAt };
}

/**
 * R10/R24: the child gets the host's environment minus the editor's own plumbing, plus the flag
 * that makes the editor's Node host behave as Node. The engine scrubs the same keys from its own
 * environment at startup, so an agent it later spawns cannot inherit them either.
 */
export function childEnv(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.NODE_OPTIONS;
  for (const key of Object.keys(env)) {
    if (key.startsWith('VSCODE_')) delete env[key];
  }
  env.ELECTRON_RUN_AS_NODE = '1';
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    env[key] = value;
  }
  return env;
}

export class NodeEngineProcess implements EngineProcessPort {
  constructor(private readonly opts: NodeEngineProcessOptions = {}) {}

  private get env(): NodeJS.ProcessEnv {
    return this.opts.env ?? process.env;
  }

  probe(socketPath: string): Promise<ProbeResult> {
    return new Promise<ProbeResult>((resolve) => {
      let settled = false;
      const done = (value: ProbeResult): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const req = http.request(
        { socketPath, path: '/version', method: 'GET', headers: { Accept: 'application/json' } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('error', () => done('foreign'));
          res.on('end', () => {
            if (res.statusCode !== 200) return done('foreign');
            let body: unknown;
            try {
              body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              return done('foreign');
            }
            done(asIdentity(body) ?? 'foreign');
          });
        },
      );
      req.setTimeout(this.opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS, () => {
        // Something holds the socket and will not answer *yet*. That is not "nobody home", and it
        // is certainly not something to start a second engine against — but neither is it proof of
        // a stranger: an engine still booting, or one busy under load, reads exactly like this.
        // The outcome is latched before the destroy, so the `error` the destroy raises cannot
        // overwrite it with `foreign`. The caller decides how many of these make a `foreign`.
        done('unreachable');
        req.destroy();
      });
      req.on('error', (err: NodeJS.ErrnoException) => {
        done(OFFLINE_CODES.has(err.code ?? '') ? null : 'foreign');
      });
      req.end();
    });
  }

  /**
   * R20. `-l` picks up the login files and `-i` the interactive ones (a `PATH` set in `.zshrc` is
   * the common case); the cap is what stops a pathological profile from hanging activation.
   */
  resolveLoginPath(): Promise<string | null> {
    const shell = this.opts.shell ?? this.env.SHELL;
    if (shell === undefined || shell === '') return Promise.resolve(null);
    return new Promise<string | null>((resolve) => {
      execFile(
        shell,
        ['-lic', 'echo $PATH'],
        { timeout: this.opts.loginPathTimeoutMs ?? LOGIN_PATH_TIMEOUT_MS, encoding: 'utf8' },
        (err, stdout) => {
          if (err !== null) return resolve(null);
          const lines = stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
          const last = lines.at(-1);
          resolve(last === undefined ? null : last);
        },
      );
    });
  }

  async spawnDetached(spec: SpawnSpec): Promise<SpawnedEngine> {
    const fd = fs.openSync(spec.logPath, 'a');
    try {
      const child = spawn(spec.execPath, spec.args, {
        cwd: spec.cwd,
        detached: true,
        stdio: ['ignore', fd, fd],
        env: childEnv(this.env, spec.env),
      });
      child.unref();
      // A spawn that fails asynchronously (a bundle that is not there, a helper binary that is not
      // executable) arrives as an `error` event. Left unhandled it would throw inside the host, so
      // it is subscribed *before* anything below can throw, and folded into the same "the child is
      // gone" report an exit produces — replayed to a listener that arrives late.
      let ended: number | null | undefined;
      const listeners: ((code: number | null) => void)[] = [];
      const end = (code: number | null): void => {
        if (ended !== undefined) return;
        ended = code;
        for (const listener of listeners.splice(0)) listener(code);
      };
      child.on('exit', (code) => end(code));
      child.on('error', () => end(null));
      if (child.pid === undefined) throw new Error('failed to spawn the engine: no pid');
      return {
        pid: child.pid,
        onExit: (cb) => {
          if (ended !== undefined) cb(ended);
          else listeners.push(cb);
        },
      };
    } finally {
      fs.closeSync(fd);
    }
  }

  /** R11/R30: one generation of history, rotated before the spawn recreates the file. */
  async rotateLog(path: string, maxBytes: number): Promise<void> {
    let size: number;
    try {
      size = (await fsp.stat(path)).size;
    } catch (err) {
      if (isErrno(err) && err.code === 'ENOENT') return;
      throw err;
    }
    if (size <= maxBytes) return;
    await fsp.rename(path, `${path}.1`);
  }

  async readPidFile(path: string): Promise<EnginePidFile | null> {
    let text: string;
    try {
      text = await fsp.readFile(path, 'utf8');
    } catch (err) {
      if (isErrno(err) && (err.code === 'ENOENT' || err.code === 'EACCES')) return null;
      throw err;
    }
    return parsePidFile(text);
  }

  /**
   * `EPERM` means the target is not ours — never a failure of our stop, and never something to
   * retry with a harder signal. `ESRCH` means it is already gone. Anything else is a real fault.
   */
  signal(pid: number, sig: 'SIGTERM'): SignalOutcome {
    try {
      process.kill(pid, sig);
      return 'signalled';
    } catch (err) {
      if (!isErrno(err)) throw err;
      if (err.code === 'ESRCH') return 'gone';
      if (err.code === 'EPERM') return 'foreign';
      throw err;
    }
  }

  async logTail(path: string, lines: number): Promise<string[]> {
    let text: string;
    try {
      text = await fsp.readFile(path, 'utf8');
    } catch {
      return [];
    }
    const all = text.split('\n');
    if (all.at(-1) === '') all.pop();
    return all.slice(-lines);
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  now(): number {
    return Date.now();
  }
}
