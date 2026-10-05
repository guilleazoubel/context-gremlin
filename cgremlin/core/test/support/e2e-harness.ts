import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createApiServer } from '../../src/api/server';
import { listenOnSocket } from '../../src/api/listen';
import { SessionStore } from '../../src/engine/session-store';
import { WorkspaceManager } from '../../src/workspace/workspace-manager';
import { StageRunner } from '../../src/pipeline/stage-runner';
import { PipelineService, type PipelineServiceDeps } from '../../src/pipeline/pipeline-service';
import { EngineEvents } from '../../src/engine/events';
import { NodeFileSystem } from '../../src/fs/node-file-system';
import { NodeGitRunner } from '../../src/git/node-git-runner';
import { KeyedLock } from '../../src/api/keyed-lock';
import { FakeAgentRunner } from './fake-agent-runner';
import { FakeGhRunner } from './fake-gh-runner';
import type { AgentExitResult, AgentHandle } from '../../src/agent/agent-runner';
import type { Session } from '../../src/schema/session';
import { mirrorDirName } from '../../src/workspace/repo-mirror';

// execFileSync passes args as a real argv array (no shell), so a multi-word
// value (like a commit message) can never be split into stray arguments —
// the bug an execSync(`git ${args.join(' ')}`) string form would hit.
function gitRun(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * A bare-minimum local "origin": one commit on `main`, plus a second commit
 * on a feature branch exposed at `refs/pull/12/head` (matching how GitHub
 * exposes a PR's head commit) — created via `update-ref` directly rather
 * than a push, since we're just populating the same repo's own ref namespace.
 */
export async function createOriginRepo(root: string): Promise<string> {
  const originPath = path.join(root, 'origin');
  gitRun(['init', '-q', '-b', 'main', originPath], root);
  gitRun(['config', 'user.email', 'e2e@example.com'], originPath);
  gitRun(['config', 'user.name', 'e2e'], originPath);

  await writeFile(path.join(originPath, 'README.md'), '# e2e\n', 'utf8');
  gitRun(['add', 'README.md'], originPath);
  gitRun(['commit', '-q', '-m', 'init'], originPath);

  gitRun(['checkout', '-q', '-b', 'feature/APP-12'], originPath);
  await writeFile(path.join(originPath, 'feature.txt'), 'feature work\n', 'utf8');
  gitRun(['add', 'feature.txt'], originPath);
  gitRun(['commit', '-q', '-m', 'feature work'], originPath);
  const sha = gitRun(['rev-parse', 'HEAD'], originPath).trim();
  gitRun(['update-ref', 'refs/pull/12/head', sha], originPath);

  gitRun(['checkout', '-q', 'main'], originPath);

  return originPath;
}

/** Pushes a new commit onto `refs/pull/<number>/head` in `originPath`, returning the new sha. */
export async function pushPrCommit(originPath: string, number: number): Promise<string> {
  const worktree = `${originPath}-pr-${number}-scratch`;
  gitRun(['worktree', 'add', '-q', '--detach', worktree, `refs/pull/${number}/head`], originPath);
  try {
    await appendFile(path.join(worktree, 'feature.txt'), 'more work\n', 'utf8');
    gitRun(['add', 'feature.txt'], worktree);
    gitRun(['commit', '-q', '-m', 'more work'], worktree);
    const sha = gitRun(['rev-parse', 'HEAD'], worktree).trim();
    gitRun(['update-ref', `refs/pull/${number}/head`, sha], originPath);
    return sha;
  } finally {
    gitRun(['worktree', 'remove', '--force', worktree], originPath);
  }
}

/**
 * ReviewSessionFactory hard-codes `https://github.com/<slug>.git` as the
 * repo URL to mirror, which can't resolve offline. This pre-creates a bare
 * mirror at the exact path `ensureMirror` would compute for that URL, by
 * cloning the local origin directly — so `ensureMirror` finds a valid
 * mirror already on disk (its "already exists" branch) and `fetch --prune
 * origin` (using whatever refspec is configured) hits the local origin.
 */
export function createMirrorFor(mirrorsDir: string, repoUrl: string, originPath: string): string {
  const mirrorPath = path.join(mirrorsDir, mirrorDirName(repoUrl));
  gitRun(['clone', '--bare', '-q', originPath, mirrorPath], mirrorsDir);
  gitRun(['config', 'remote.origin.url', originPath], mirrorPath);
  return mirrorPath;
}

function requestOnSocket(
  socketPath: string,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath,
        path: urlPath,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsedBody: unknown;
          if (raw) {
            try {
              parsedBody = JSON.parse(raw);
            } catch {
              parsedBody = raw;
            }
          }
          resolve({ status: res.statusCode ?? 0, body: parsedBody });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export interface EngineFakes {
  runner?: FakeAgentRunner;
  gh?: FakeGhRunner;
  /** 0c — the engine's tickets port; omitted means no Jira wiring (a linked ticket then fails the preflight). */
  tickets?: PipelineServiceDeps['tickets'];
}

export interface Engine {
  socketPath: string;
  request(method: string, urlPath: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  runner: FakeAgentRunner;
  gh: FakeGhRunner;
  events: EngineEvents;
  store: SessionStore;
  workspace: WorkspaceManager;
  pipeline: PipelineService;
  lock: KeyedLock;
  sessionsDir: string;
  worktreesDir: string;
  mirrorsDir: string;
  close(): Promise<void>;
}

export async function startEngine(root: string, fakes: EngineFakes = {}): Promise<Engine> {
  const sessionsDir = path.join(root, 'sessions');
  const mirrorsDir = path.join(root, 'mirrors');
  const worktreesDir = path.join(root, 'worktrees');
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(mirrorsDir, { recursive: true });
  await mkdir(worktreesDir, { recursive: true });

  const fs = new NodeFileSystem();
  const git = new NodeGitRunner();
  const store = new SessionStore(fs, sessionsDir);
  const workspace = new WorkspaceManager(git, fs, mirrorsDir);
  const events = new EngineEvents();
  const runner = fakes.runner ?? new FakeAgentRunner();
  const gh = fakes.gh ?? new FakeGhRunner();
  const lock = new KeyedLock();
  const stageRunner = new StageRunner({
    runner,
    store,
    fs,
    events,
    sessionsDir,
    runnerKind: 'claude-code',
    lock,
  });
  const pipeline = new PipelineService({
    store,
    workspace,
    stageRunner,
    fs,
    git,
    events,
    config: { sessionsDir, worktreesDir, defaultBaseRef: 'origin/main' , runnerKind: 'claude-code', humanTurnTtlMs: 600_000 },
    lock,
    ghAuthOk: async () => ({ ok: true as const }),
    ...(fakes.tickets !== undefined ? { tickets: fakes.tickets } : {}),
  });
  const server = createApiServer({
    sessionStore: store,
    workspaceManager: workspace,
    pipeline,
    fs,
    sessionsDir,
    events,
    lock,
    // Real NodeGitRunner — GET /sessions/:id/changes shells out for real here.
    git,
  });
  const socketPath = path.join(tmpdir(), `cg-e2e-${randomBytes(4).toString('hex')}.sock`);
  await listenOnSocket(server, socketPath);

  return {
    socketPath,
    request: (method, urlPath, body) => requestOnSocket(socketPath, method, urlPath, body),
    runner,
    gh,
    events,
    store,
    workspace,
    pipeline,
    lock,
    sessionsDir,
    worktreesDir,
    mirrorsDir,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Writes the given files into the session dir the last-started agent handle
 * was given (its first `additionalDirs` entry — see StageRunner), then emits
 * its exit. Mirrors an agent's real behavior: it writes artifacts, then the
 * CLI process exits.
 */
export async function finishRun(
  runner: FakeAgentRunner,
  files: Record<string, string>,
  exit: AgentExitResult,
): Promise<void> {
  const handle = runner.lastHandle();
  const ctx = runner.getContext(handle);
  const sessionDir = ctx.additionalDirs?.[0];
  if (!sessionDir) {
    throw new Error('finishRun: the last agent handle has no additionalDirs to write artifacts into');
  }
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(sessionDir, name), content, 'utf8');
  }
  runner.emitExit(handle, exit);
}

/** Polls `GET /sessions/:id` until `predicate` is true or `timeoutMs` elapses. */
export async function waitFor(
  engine: Pick<Engine, 'request'>,
  id: string,
  predicate: (session: Session) => boolean,
  timeoutMs = 10_000,
): Promise<Session> {
  const deadline = Date.now() + timeoutMs;
  let last: Session | undefined;
  for (;;) {
    const res = await engine.request('GET', `/sessions/${id}`);
    if (res.status === 200) {
      last = (res.body as { session: Session }).session;
      if (predicate(last)) return last;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `waitFor timed out after ${timeoutMs}ms for session '${id}'` +
          (last ? ` (last seen stageStatus='${last.stageStatus}')` : ' (session never returned 200)'),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Polls `GET /sessions` until some session matches `predicate`, or `timeoutMs`
 * elapses. Use this (rather than `waitFor` on a known id) when the session
 * you care about doesn't exist yet, or when a field on it (e.g. `lastRun`)
 * is set by a later step in the same request chain than the one that
 * created the session — `promote()` creates the development session and
 * only afterwards starts its develop run, so "the session exists" and "its
 * run has started" are two separate moments to poll for.
 */
export async function waitForAnySession(
  engine: Pick<Engine, 'request'>,
  predicate: (session: Session) => boolean,
  timeoutMs = 10_000,
): Promise<Session> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await engine.request('GET', '/sessions');
    if (res.status === 200) {
      const sessions = (res.body as { sessions: Session[] }).sessions;
      const match = sessions.find(predicate);
      if (match) return match;
    }
    if (Date.now() >= deadline) {
      throw new Error(`waitForAnySession timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Polls `runner.lastHandle()` until it differs from `previous`, or `timeoutMs` elapses. */
export async function waitForNewHandle(
  runner: FakeAgentRunner,
  previous: AgentHandle,
  timeoutMs = 10_000,
): Promise<AgentHandle> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = runner.lastHandle();
      if (handle.id !== previous.id) return handle;
    } catch {
      // no handle started yet — keep polling
    }
    if (Date.now() >= deadline) {
      throw new Error(`waitForNewHandle timed out after ${timeoutMs}ms waiting past handle '${previous.id}'`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
