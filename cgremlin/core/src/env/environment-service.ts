import * as os from 'node:os';
import type { SessionFileSystem } from '../fs/session-file-system';
import type { GhRunner } from '../gh/gh-runner';
import type { GitRunner } from '../git/git-runner';
import type { KeyedLock } from '../api/keyed-lock';
import type { CoreConfig, RepoEnvironment } from '../config/core-config';
import { ClerkConfigSchema, redactBypassUrls } from '../config/core-config';
import { repoSlugFromUrl } from '../gh/repo-slug';
import type { Session } from '../schema/session';
import type { StageName } from '../schema/stage';
import { PR_COMMENTS_FIELDS, parsePrComments } from '../gh/pr-view';
import { parseVercelPreviewComment, pickPreviewProject } from './vercel-preview';
import { EMPTY_ENVIRONMENT, type EnvironmentBriefContext } from '../pipeline/prompts';
import {
  LocalAppPortBusyError,
  LocalAppPrereqError,
  LocalAppSetupError,
  LocalAppUnhealthyError,
  type LocalAppProcess,
  type LocalAppRunner,
  type LocalAppSetupStep,
} from './local-app-runner';

export { EMPTY_ENVIRONMENT, type EnvironmentBriefContext };

export interface LocalAppState {
  sessionId: string;
  repoSlug: string;
  url: string;
  port: number;
  pid: number;
  pgid: number;
  logPath: string;
  startedAt: string;
}

export interface LocalAppStatus {
  state: 'running' | 'stopped' | 'unavailable';
  sessionId: string | null;
  url: string | null;
  pid: number | null;
  logPath: string | null;
  startedAt: string | null;
  reason: string | null;
  /** Redacted (R3). */
  logTail: string | null;
  /**
   * W8: set only when the API masks a running app's status for a session
   * that did not start it — names the session id that actually owns it,
   * while `state` reports 'stopped' to that caller. Never set by
   * EnvironmentService itself; the API layer fills it in.
   */
  ownedBy?: string | null;
}

export interface EnvironmentServiceDeps {
  fs: SessionFileSystem;
  gh: GhRunner;
  git: GitRunner;
  local: LocalAppRunner;
  config: CoreConfig;
  sessionsDir: string;
  statePath: string;
  lock: KeyedLock;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** When this machine last booted, in epoch ms; injectable so the pid-reuse guard is testable. */
  bootTimeMs?: () => number;
}

export const BYPASS_SECRET_FILE = '.bypass-secret';
/** W4: what `start()` reports when a shutdown aborted it mid-flight. */
export const ABORTED_REASON = 'aborted';
const SECRET_FILE_MODE = 0o600;
/** R11: the head of the dev log is what carries the repo's own refusal message. */
const PREREQ_LOG_LINES = 40;
/** Legacy `tail -20` on the healthcheck-timeout path (`bin/cgremlin:631`). */
const TIMEOUT_LOG_LINES = 20;
const STATUS_LOG_LINES = 40;
const HOSTS_FILE = '/etc/hosts';
/** `nvm use` failed inside the login-shell wrapper (EX_CONFIG) — R12. */
const NVM_WRAPPER_EXIT = 78;

const STOPPED: LocalAppStatus = {
  state: 'stopped',
  sessionId: null,
  url: null,
  pid: null,
  logPath: null,
  startedAt: null,
  reason: null,
  logTail: null,
};

function unavailable(reason: string): LocalAppStatus {
  return { ...STOPPED, state: 'unavailable', reason: redactBypassUrls(reason) };
}

function foreignListenerMessage(port: number, pid: number | undefined): string {
  return `port ${port} is still held by pid ${pid ?? '?'}, which the engine did not start — it was not killed; stop it yourself or change localApp.port`;
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

function procOf(state: LocalAppState): LocalAppProcess {
  return { pid: state.pid, pgid: state.pgid, startedAt: state.startedAt };
}

/** W4: a `start()` the engine aborted while shutting down — the stage must not carry on. */
export class EnvironmentAbortedError extends Error {
  constructor(sessionId: string) {
    super(`environment preparation for session '${sessionId}' was aborted (the engine is shutting down)`);
    this.name = 'EnvironmentAbortedError';
  }
}

export class EnvironmentService {
  /** The most recent `start()` outcome, so `briefContext` can report R5's degrade reason. */
  private lastStart: { sessionId: string; status: LocalAppStatus } | null = null;
  /** W4: `start()` calls still in flight, so a shutdown can abort one that is still waiting on a healthcheck. */
  private readonly inFlight = new Map<string, { abort: () => void; done: Promise<void> }>();

  constructor(private readonly deps: EnvironmentServiceDeps) {}

  environmentFor(repoUrl: string): RepoEnvironment | undefined {
    return this.deps.config.environments[repoSlugFromUrl(repoUrl)];
  }

  wantsLocalApp(repoUrl: string, stage: StageName): boolean {
    const env = this.environmentFor(repoUrl);
    return env?.localApp?.stages.includes(stage) ?? false;
  }

  wantsPreview(repoUrl: string, stage: StageName): boolean {
    const env = this.environmentFor(repoUrl);
    return env?.vercel !== undefined && env.previewStages.includes(stage);
  }

  // ---- prereqs (R11) ----

  private expandHome(value: string): string {
    const home = this.deps.env?.HOME;
    if (home === undefined) return value;
    if (value === '~') return home;
    return value.startsWith('~/') ? `${home}${value.slice(1)}` : value;
  }

  async checkPrereqs(env: RepoEnvironment): Promise<string[]> {
    const messages: string[] = [];
    const local = env.localApp;
    if (local !== undefined) {
      const prereqs = local.prereqs;
      if (prereqs.hostsEntries.length > 0) {
        let hosts = '';
        try {
          hosts = await this.deps.fs.readFile(HOSTS_FILE);
        } catch {
          hosts = '';
        }
        for (const entry of prereqs.hostsEntries) {
          if (!hosts.includes(entry)) {
            messages.push(
              `PREREQ: /etc/hosts is missing '${entry}'. Run 'pnpm setup:local' in the repo, with you present (needs sudo).`,
            );
          }
        }
      }
      for (const file of prereqs.requiredFiles) {
        if (!(await this.deps.fs.exists(this.expandHome(file)))) {
          messages.push(missingFileMessage(file, local.nodeVersion));
        }
      }
      for (const name of prereqs.requiredEnv) {
        const value = this.deps.env?.[name];
        if (value === undefined || value === '') {
          messages.push(missingEnvMessage(name));
        }
      }
    }
    if (env.vercel !== undefined) {
      const result = await this.deps.local.exec('vercel whoami', { cwd: this.deps.sessionsDir });
      if (result.code !== 0) {
        messages.push("PREREQ: not logged into Vercel. Run 'vercel login'.");
      }
    }
    return messages;
  }

  // ---- per-checkout setup (legacy step 3) ----

  private async isNonEmptyDir(path: string): Promise<boolean> {
    if (!(await this.deps.fs.exists(path))) return false;
    try {
      return (await this.deps.fs.readdir(path)).length > 0;
    } catch {
      return false;
    }
  }

  private async needsSetup(cwd: string, env: RepoEnvironment, fresh: boolean): Promise<boolean> {
    if (fresh) return true;
    const envFile = env.vercel?.envFile ?? '.env.local';
    if (!(await this.deps.fs.exists(`${cwd}/${envFile}`))) return true;
    if (!(await this.deps.fs.exists(`${cwd}/node_modules`))) return true;
    for (const dir of env.localApp?.postInstallNonEmptyDirs ?? []) {
      // A directory that does not exist at all counts as empty (verified live).
      if (!(await this.isNonEmptyDir(`${cwd}/${dir}`))) return true;
    }
    return false;
  }

  private async runSetupExec(
    command: string,
    opts: { cwd: string; nodeVersion?: string; logPath?: string },
    onFailure: (code: number | null) => string,
    step: LocalAppSetupStep,
  ): Promise<void> {
    const result = await this.deps.local.exec(command, opts);
    if (result.code === NVM_WRAPPER_EXIT) {
      throw new LocalAppPrereqError(
        `PREREQ: could not select Node ${opts.nodeVersion ?? '?'} via nvm (the dev-shell wrapper exited ${NVM_WRAPPER_EXIT}).`,
      );
    }
    if (result.code !== 0) throw new LocalAppSetupError(onFailure(result.code), step);
  }

  /** After `vercel env pull`, make sure the pulled secrets can never be committed. */
  private async ensureGitignored(cwd: string, envFile: string): Promise<void> {
    try {
      await this.deps.git.run(['check-ignore', '-q', envFile, '.vercel'], { cwd });
      return;
    } catch {
      // `git check-ignore` exits non-zero when any listed path is not ignored.
    }
    const { stdout } = await this.deps.git.run(['rev-parse', '--git-path', 'info/exclude'], { cwd });
    const raw = stdout.trim();
    // A linked worktree's `.git` is a file, so the path git reports is the one to use.
    const excludePath = raw.startsWith('/') ? raw : `${cwd}/${raw}`;
    let existing = '';
    if (await this.deps.fs.exists(excludePath)) {
      existing = await this.deps.fs.readFile(excludePath);
    } else {
      await this.deps.fs.mkdir(dirnameOf(excludePath), { recursive: true });
    }
    const lines = existing.split('\n').map((line) => line.trim());
    const missing = [envFile, '.vercel'].filter((entry) => !lines.includes(entry));
    if (missing.length === 0) return;
    const prefix = existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`;
    await this.deps.fs.writeFile(excludePath, `${prefix}${missing.join('\n')}\n`);
  }

  async ensureSetup(session: Session, env: RepoEnvironment, logPath: string, fresh: boolean): Promise<void> {
    const cwd = session.workspace.worktreePath;
    if (cwd === undefined) throw new Error(`ERROR: repo missing for session '${session.id}'`);
    if (!(await this.needsSetup(cwd, env, fresh))) return;

    const nodeVersion = env.localApp?.nodeVersion;
    const envFile = env.vercel?.envFile ?? '.env.local';
    if (env.vercel !== undefined) {
      const { scope, project } = env.vercel;
      await this.runSetupExec(
        `vercel link --yes --scope ${scope} --project ${project}`,
        { cwd, nodeVersion },
        () => `ERROR: vercel link failed (scope ${scope} / project ${project})`,
        'vercel link',
      );
      await this.runSetupExec(
        `vercel env pull ${envFile}`,
        { cwd, nodeVersion },
        () => 'ERROR: vercel env pull failed',
        'vercel env pull',
      );
      let pulled = '';
      try {
        pulled = await this.deps.fs.readFile(`${cwd}/${envFile}`);
      } catch {
        pulled = '';
      }
      if (!pulled.split('\n').some((line) => line.includes('='))) {
        throw new LocalAppSetupError(`ERROR: ${envFile} came back empty`, 'env file');
      }
      await this.ensureGitignored(cwd, envFile);
    }

    const installCommand = env.localApp?.installCommand ?? 'pnpm install';
    await this.runSetupExec(
      installCommand,
      { cwd, nodeVersion, logPath: `${logPath}.install` },
      () => `ERROR: ${installCommand} failed — see ${logPath}.install`,
      'pnpm install',
    );
    for (const dir of env.localApp?.postInstallNonEmptyDirs ?? []) {
      if (!(await this.isNonEmptyDir(`${cwd}/${dir}`))) {
        throw new LocalAppSetupError(
          `ERROR: dev backend unreachable — API types not generated (${dir} is empty); the app won't run correctly. See ${logPath}.install`,
          'generated dir',
        );
      }
    }
  }

  // ---- state file (R15: every read-modify-write under `local-app:<port>`) ----

  private async readState(): Promise<LocalAppState | null> {
    try {
      return JSON.parse(await this.deps.fs.readFile(this.deps.statePath)) as LocalAppState;
    } catch {
      return null;
    }
  }

  private async writeState(state: LocalAppState): Promise<void> {
    const { fs, statePath } = this.deps;
    await fs.mkdir(dirnameOf(statePath), { recursive: true });
    const tmpPath = `${statePath}.${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
    await fs.rename(tmpPath, statePath);
  }

  private async logTailOf(logPath: string | null, lines: number): Promise<string | null> {
    if (logPath === null) return null;
    const tail = await this.deps.local.tailLog(logPath, lines);
    return tail === '' ? null : redactBypassUrls(tail);
  }

  private async runningStatus(state: LocalAppState): Promise<LocalAppStatus> {
    return {
      state: 'running',
      sessionId: state.sessionId,
      url: state.url,
      pid: state.pid,
      logPath: state.logPath,
      startedAt: state.startedAt,
      reason: null,
      logTail: await this.logTailOf(state.logPath, STATUS_LOG_LINES),
    };
  }

  async status(): Promise<LocalAppStatus> {
    const state = await this.readState();
    return state === null ? { ...STOPPED } : this.runningStatus(state);
  }

  // ---- start (legacy `run_local`, `bin/cgremlin:560-633`) ----

  async start(session: Session, opts: { fresh?: boolean } = {}): Promise<LocalAppStatus> {
    const controller = new AbortController();
    // Registered synchronously (no await before the `set`) so an `abortAll()`
    // racing this call can never miss it.
    const run = this.startInner(session, opts, controller.signal).catch((err: unknown) => {
      if (
        err instanceof LocalAppPortBusyError ||
        err instanceof LocalAppPrereqError ||
        err instanceof LocalAppUnhealthyError ||
        err instanceof LocalAppSetupError
      ) {
        return unavailable(err.message);
      }
      throw err;
    });
    const entry = {
      abort: () => controller.abort(),
      done: run.then(
        () => undefined,
        () => undefined,
      ),
    };
    this.inFlight.set(session.id, entry);
    try {
      const status = await run;
      this.lastStart = { sessionId: session.id, status };
      return status;
    } finally {
      // Only clear our own entry — a later start for the same session may
      // already have taken the slot.
      if (this.inFlight.get(session.id) === entry) this.inFlight.delete(session.id);
    }
  }

  /**
   * W4: abort every `start()` still in flight and wait for each to unwind.
   * Until this exists, `close()` cannot stop a start that has spawned a dev
   * server and is sitting in its healthcheck: there is no active run to stop
   * and (before the record below) nothing on disk for `stop()` to find.
   */
  async abortAll(): Promise<void> {
    const entries = [...this.inFlight.values()];
    for (const entry of entries) entry.abort();
    await Promise.all(entries.map((entry) => entry.done));
  }

  private async startInner(
    session: Session,
    opts: { fresh?: boolean },
    signal: AbortSignal,
  ): Promise<LocalAppStatus> {
    const env = this.environmentFor(session.workspace.repoUrl);
    const local = env?.localApp;
    if (env === undefined || local === undefined) {
      return unavailable(`no local app is configured for '${repoSlugFromUrl(session.workspace.repoUrl)}'`);
    }
    const cwd = session.workspace.worktreePath;
    if (cwd === undefined || !(await this.deps.fs.exists(cwd))) {
      return unavailable(`ERROR: repo missing for session '${session.id}'`);
    }
    if (!(await this.hasDevScript(cwd, local.devCommand))) {
      return unavailable(`ERROR: ${cwd} is not a runnable checkout (no dev script)`);
    }

    const sessionDir = `${this.deps.sessionsDir}/${session.id}`;
    const logPath = `${sessionDir}/logs/dev-server.log`;
    await this.deps.fs.mkdir(`${sessionDir}/logs`, { recursive: true });

    const prereqFailures = await this.checkPrereqs(env);
    if (prereqFailures.length > 0) return unavailable(prereqFailures.join('\n'));

    await this.ensureSetup(session, env, logPath, opts.fresh === true);

    return this.deps.lock.withLock(`local-app:${local.port}`, () =>
      this.startLocked(session, env, cwd, logPath, signal),
    );
  }

  private async hasDevScript(cwd: string, devCommand: string): Promise<boolean> {
    try {
      const raw = await this.deps.fs.readFile(`${cwd}/package.json`);
      const scripts = (JSON.parse(raw) as { scripts?: Record<string, string> }).scripts ?? {};
      return scripts.dev !== undefined || Object.values(scripts).includes(devCommand);
    } catch {
      return false;
    }
  }

  private async startLocked(
    session: Session,
    env: RepoEnvironment,
    cwd: string,
    logPath: string,
    signal: AbortSignal,
  ): Promise<LocalAppStatus> {
    const local = env.localApp!;
    const { port, url } = local;
    const existing = await this.readState();
    if (existing !== null) {
      if (existing.sessionId === session.id) {
        const alive = await this.deps.local.isAlive(procOf(existing));
        if (alive) {
          const health = await this.deps.local.healthcheck(existing.url, {
            timeoutMs: local.healthIntervalMs,
            intervalMs: local.healthIntervalMs,
            insecureTls: local.insecureTls,
            proc: procOf(existing),
          });
          // Legacy idempotency (`bin/cgremlin:601`): our own app, answering 2xx.
          if (health.ok) return this.runningStatus(existing);
          // Ours but wedged — stopping it is safe, it is a process we started.
          const stopped = await this.deps.local.stop(procOf(existing), { port });
          if (!stopped.freed) {
            await this.deps.fs.remove(this.deps.statePath);
            throw new LocalAppPortBusyError(port, stopped.foreignListener ?? existing.pid, false);
          }
        }
        await this.deps.fs.remove(this.deps.statePath);
      } else {
        const listener = await this.deps.local.portListenerPid(port);
        if (listener !== null) {
          const ours =
            listener === existing.pid ||
            listener === existing.pgid ||
            (await this.deps.local.pgidOf(listener)) === existing.pgid;
          throw new LocalAppPortBusyError(port, listener, ours, existing.sessionId);
        }
        await this.deps.fs.remove(this.deps.statePath);
      }
    } else {
      const listener = await this.deps.local.portListenerPid(port);
      // R6/R13: a process the engine did not start is never killed.
      if (listener !== null) throw new LocalAppPortBusyError(port, listener, false);
    }

    // W4: nothing has been spawned yet — an abort here costs nothing to honour.
    if (signal.aborted) return unavailable(ABORTED_REASON);

    const proc = await this.deps.local.start({
      cwd,
      command: local.devCommand,
      nodeVersion: local.nodeVersion,
      logPath,
    });
    const recordOf = (pid: number, pgid: number): LocalAppState => ({
      sessionId: session.id,
      repoSlug: repoSlugFromUrl(session.workspace.repoUrl),
      url,
      port,
      pid,
      pgid,
      logPath,
      startedAt: proc.startedAt,
    });
    // W4: record the process the moment it exists — BEFORE the healthcheck.
    // An engine that dies mid-wait must leave the next boot's reap something
    // to kill, rather than an unrecorded dev server nobody owns.
    await this.writeState(recordOf(proc.pid, proc.pgid));
    try {
      const health = await this.deps.local.healthcheck(url, {
        timeoutMs: local.healthTimeoutMs,
        intervalMs: local.healthIntervalMs,
        insecureTls: local.insecureTls,
        proc,
        signal,
      });
      if (signal.aborted) {
        // Shutting down: the app we just spawned is ours to take back down.
        await this.deps.local.stop(proc, { port });
        await this.deps.fs.remove(this.deps.statePath);
        return unavailable(ABORTED_REASON);
      }
      if (health.exited) {
        // R11: the dev command refused to start — report its own message, do not work around it.
        const head = await this.deps.local.headLog(logPath, PREREQ_LOG_LINES);
        throw new LocalAppPrereqError(
          `the dev command exited before ${url} answered. First ${PREREQ_LOG_LINES} log lines:\n${head}`,
        );
      }
      if (!health.ok) {
        await this.deps.local.stop(proc, { port });
        const tail = await this.deps.local.tailLog(logPath, TIMEOUT_LOG_LINES);
        throw new LocalAppUnhealthyError(
          `${url} did not come up within ${Math.round(local.healthTimeoutMs / 1000)}s. Last log lines:\n${tail}`,
        );
      }

      // R16: the pnpm wrapper forks, so the listener — not the spawned child — is what we must record.
      let pid = proc.pid;
      let pgid = proc.pgid;
      const listener = await this.deps.local.portListenerPid(port);
      if (listener !== null && listener !== proc.pid) {
        pid = listener;
        pgid = (await this.deps.local.pgidOf(listener)) ?? proc.pgid;
      }
      const state = recordOf(pid, pgid);
      await this.writeState(state);
      return this.runningStatus(state);
    } catch (err) {
      // The pre-healthcheck record must not outlive a start that failed —
      // it would make `status` claim a dead app is running.
      await this.deps.fs.remove(this.deps.statePath).catch(() => undefined);
      throw err;
    }
  }

  // ---- stop / reap ----

  /**
   * W3: a recorded pid/pgid is only worth signalling while we can still tell
   * it apart from a reused one. Two things prove that: the group still owns
   * the port we recorded, or the record was written after this machine last
   * booted (pids do not survive a reboot). Neither — signal nothing.
   */
  private async ownsRecordedProcess(state: LocalAppState): Promise<boolean> {
    const listener = await this.deps.local.portListenerPid(state.port);
    if (listener !== null && (await this.deps.local.pgidOf(listener)) === state.pgid) return true;
    const startedAt = Date.parse(state.startedAt);
    if (Number.isNaN(startedAt)) return false;
    const bootTime = this.deps.bootTimeMs?.() ?? Date.now() - os.uptime() * 1000;
    return startedAt > bootTime;
  }

  async stop(sessionId?: string): Promise<LocalAppStatus> {
    const current = await this.readState();
    if (current === null) return { ...STOPPED };
    return this.deps.lock.withLock(`local-app:${current.port}`, async () => {
      const state = await this.readState();
      if (state === null) return { ...STOPPED };
      if (sessionId !== undefined && sessionId !== state.sessionId) {
        // Never stop another session's app (legacy `stop_local`'s owner guard).
        return this.runningStatus(state);
      }
      if (!(await this.ownsRecordedProcess(state))) {
        await this.deps.fs.remove(this.deps.statePath);
        if (this.lastStart?.sessionId === state.sessionId) this.lastStart = null;
        return { ...STOPPED };
      }
      const result = await this.deps.local.stop(procOf(state), { port: state.port });
      await this.deps.fs.remove(this.deps.statePath);
      if (this.lastStart?.sessionId === state.sessionId) this.lastStart = null;
      // R6: our group is gone but somebody else's process holds the port —
      // say so, rather than reporting a clean stop the next start will trip over.
      if (!result.freed) return unavailable(foreignListenerMessage(state.port, result.foreignListener));
      return { ...STOPPED };
    });
  }

  /**
   * R13: at boot, reap the process group this engine itself recorded — and
   * nothing else. W3: a record we can no longer prove is ours (it predates
   * the boot and does not own the port) is only cleared, never signalled;
   * the caller logs it as `local.reap_stale`.
   */
  async reconcileOrphans(): Promise<{
    reaped: LocalAppState | null;
    alreadyDead: boolean;
    stale: LocalAppState | null;
  }> {
    const current = await this.readState();
    if (current === null) return { reaped: null, alreadyDead: false, stale: null };
    return this.deps.lock.withLock(`local-app:${current.port}`, async () => {
      const state = await this.readState();
      if (state === null) return { reaped: null, alreadyDead: false, stale: null };
      if (!(await this.ownsRecordedProcess(state))) {
        await this.deps.fs.remove(this.deps.statePath);
        this.lastStart = null;
        return { reaped: null, alreadyDead: false, stale: state };
      }
      const alive = await this.deps.local.isAlive(procOf(state));
      if (alive) await this.deps.local.stop(procOf(state), { port: state.port });
      await this.deps.fs.remove(this.deps.statePath);
      this.lastStart = null;
      return { reaped: state, alreadyDead: !alive, stale: null };
    });
  }

  // ---- preview URL (R7) ----

  async previewUrlFor(
    session: Session,
  ): Promise<{ url: string | null; reason: string | null; status: string | null }> {
    const env = this.environmentFor(session.workspace.repoUrl);
    const vercel = env?.vercel;
    if (vercel === undefined) {
      return {
        url: null,
        reason: `no vercel configuration for '${repoSlugFromUrl(session.workspace.repoUrl)}'`,
        status: null,
      };
    }
    const pr = session.pr;
    if (pr === null) return { url: null, reason: 'the session has no PR yet', status: null };

    let stdout: string;
    try {
      const result = await this.deps.gh.run([
        'pr',
        'view',
        String(pr.number),
        '--repo',
        pr.repo,
        '--json',
        PR_COMMENTS_FIELDS,
      ]);
      stdout = result.stdout;
    } catch (err) {
      return { url: null, reason: `gh pr view failed: ${(err as Error).message}`, status: null };
    }
    let bodies: string[];
    try {
      // Only the `vercel` bot's own comments are decoded — the login is exactly `vercel`.
      bodies = parsePrComments(stdout)
        .filter((comment) => comment.author.login === 'vercel')
        .map((comment) => comment.body);
    } catch (err) {
      return { url: null, reason: `gh pr view failed: ${(err as Error).message}`, status: null };
    }
    const projects = parseVercelPreviewComment(bodies);
    if (projects.length === 0) return { url: null, reason: 'no vercel comment on the PR', status: null };
    const project = pickPreviewProject(projects, vercel.previewProject);
    if (project === null) {
      return {
        url: null,
        reason: `no project '${vercel.previewProject}' in the vercel comment`,
        status: null,
      };
    }
    if (project.previewUrl === null || project.previewUrl === '') {
      return {
        url: null,
        reason: `project '${vercel.previewProject}' has no preview URL yet (nextCommitStatus=${project.nextCommitStatus})`,
        status: project.nextCommitStatus,
      };
    }
    // A non-DEPLOYED status still carries a usable URL (verified live on PENDING).
    return { url: `https://${project.previewUrl}`, reason: null, status: project.nextCommitStatus };
  }

  // ---- bypass secret file (R3) ----

  async writeBypassSecret(sessionDir: string, repoUrl: string): Promise<string | null> {
    const secret = this.environmentFor(repoUrl)?.vercel?.bypassSecret;
    if (secret === undefined) return null;
    const path = `${sessionDir}/${BYPASS_SECRET_FILE}`;
    await this.deps.fs.writeFile(path, `${secret}\n`, { mode: SECRET_FILE_MODE });
    return path;
  }

  async clearBypassSecret(sessionDir: string): Promise<void> {
    await this.deps.fs.remove(`${sessionDir}/${BYPASS_SECRET_FILE}`);
  }

  // ---- brief context (R14) ----

  async briefContext(session: Session, stage: StageName): Promise<EnvironmentBriefContext> {
    const repoUrl = session.workspace.repoUrl;
    const env = this.environmentFor(repoUrl);
    if (env === undefined) return { ...EMPTY_ENVIRONMENT };

    const ctx: EnvironmentBriefContext = { ...EMPTY_ENVIRONMENT };
    if (this.wantsLocalApp(repoUrl, stage)) {
      const status =
        this.lastStart?.sessionId === session.id ? this.lastStart.status : await this.status();
      if (status.state === 'running' && status.sessionId === session.id) {
        ctx.localUrl = status.url;
        ctx.localLogPath = status.logPath;
      } else {
        ctx.localUnavailableReason = status.reason ?? 'the local app is not running';
      }
    }
    if (this.wantsPreview(repoUrl, stage)) {
      const preview = await this.previewUrlFor(session);
      ctx.previewUrl = preview.url;
      ctx.previewUnavailableReason = preview.reason;
      ctx.previewStatus = preview.status;
      if (preview.url !== null && env.vercel?.bypassSecret !== undefined) {
        ctx.bypassSecretPath = `${this.deps.sessionsDir}/${session.id}/${BYPASS_SECRET_FILE}`;
      }
    }
    if (env.clerk !== undefined) {
      const clerk = ClerkConfigSchema.parse(env.clerk);
      ctx.clerk = { emailTemplate: clerk.testEmailTemplate, verificationCode: clerk.verificationCode };
    }
    return ctx;
  }
}

// The legacy wording for the four prerequisites `_local_prereqs` hardcoded
// (`bin/cgremlin:524-535`); anything else a repo configures gets a generic line.
function missingFileMessage(file: string, nodeVersion: string | undefined): string {
  if (file === '/Library/LaunchDaemons/com.grace.portforward.plist') {
    return "PREREQ: the 443→8080 port-forward daemon is missing. Run 'pnpm setup:local' in the repo, with you present (needs sudo).";
  }
  if (file === '~/.nvm/nvm.sh') {
    return `PREREQ: nvm not found at ~/.nvm/nvm.sh (needed for Node ${nodeVersion ?? '?'}).`;
  }
  return `PREREQ: required file '${file}' is missing.`;
}

function missingEnvMessage(name: string): string {
  if (name === 'NODE_AUTH_TOKEN') {
    return 'PREREQ: NODE_AUTH_TOKEN is not set (needed for @aplaceformom/* packages). Export a GitHub PAT with read:packages (the gh oauth token lacks that scope).';
  }
  return `PREREQ: ${name} is not set.`;
}
