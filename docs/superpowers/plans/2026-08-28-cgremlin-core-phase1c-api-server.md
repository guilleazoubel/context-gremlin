# cgremlin/core Phase 1c: Local API Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the engine (Phase 1a's `SessionStore`, Phase 1b's `WorkspaceManager`) over a local HTTP-over-Unix-domain-socket JSON API — the API boundary any future frontend (a modernized dashboard, or later a "plugin style" UI) builds against, per the rebuild spec. Closes the concurrency gap Phase 1a's final review explicitly flagged as a required Phase 1c prerequisite: `SessionStore.transition()` is an unguarded read-modify-write, unsafe under concurrent requests for the same session id.

**Architecture:** A `KeyedLock` (per-key async mutex) serializes concurrent requests for the same session id at the API boundary — exactly where the spec said this belongs, not baked into `SessionStore` itself. A pure `mapErrorToHttp` function translates the engine's typed errors (`SessionNotFoundError`, `InvalidSessionIdError`, `IllegalTransitionError`, etc.) into HTTP status codes. `createApiServer` wires a small router (six routes) directly against `SessionStore`/`WorkspaceManager`, using Node's built-in `http` module listening on a Unix domain socket — no new dependency, no network exposure. `listenOnSocket` handles the one operational wrinkle a UDS server has that a TCP server doesn't: a stale socket file left over from an unclean shutdown must be removed before listening, or `EADDRINUSE` is thrown even though nothing is actually listening.

**Tech Stack:** TypeScript, vitest, `node:http` (server + real integration-test client), `node:fs/promises` (socket-file cleanup only — a distinct, narrow domain from `SessionFileSystem`, which is scoped to session persistence, not OS socket files).

**Spec:** `cgremlin/core/docs/superpowers/specs/2026-08-28-cgremlin-core-rebuild-design.md` (section 2 "Engine (daemon)" — the local API server; section 9 references this as the boundary future UIs build against)

## Global Constraints

- Fully local — Unix domain socket only, no TCP/network listener, no hosted backend.
- Reuses Phase 1a's `SessionStore`/`SessionFileSystem`/`InMemoryFileSystem` and Phase 1b's `WorkspaceManager`/`GitRunner`/`FakeGitRunner` exactly, unmodified.
- The API layer is the *only* place session-id concurrency is serialized — do not add locking inside `SessionStore` itself (already ruled out in Phase 1a).
- `node:fs/promises`'s `unlink` is permitted only inside `src/api/listen.ts`, for OS socket-file cleanup — a distinct concern from `SessionFileSystem` (which is scoped to session persistence). No other new file may import `node:fs`.
- The API server's own request-handling tests must exercise real HTTP-over-UDS requests (a deliberate real-I/O exception, same pattern as `NodeFileSystem`'s and `NodeGitRunner`'s tests) — the storage/git layers underneath stay fully faked (`InMemoryFileSystem`/`FakeGitRunner`) so these tests remain fast and don't touch real disk or git.
- Package manager pnpm (v10.10.0), Node 24. Run all commands from `cgremlin/core/`.
- TDD: every task writes the failing test before the implementation.

---

### Task 1: `KeyedLock` (per-key async mutex)

**Files:**
- Create: `cgremlin/core/src/api/keyed-lock.ts`
- Test: `cgremlin/core/test/api/keyed-lock.test.ts`

**Interfaces:**
- Produces: `class KeyedLock { withLock<T>(key: string, fn: () => Promise<T>): Promise<T> }` — runs `fn` calls for the same `key` strictly one at a time, in call order; calls for different keys run concurrently; a thrown error from one call does not block subsequent calls for the same key. Consumed by Task 3's `createApiServer` to serialize `transition` and workspace-teardown requests per session id.

- [ ] **Step 1: Write the failing test**

`cgremlin/core/test/api/keyed-lock.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { KeyedLock } from '../../src/api/keyed-lock';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('KeyedLock', () => {
  it('runs calls for the same key strictly in order, one at a time', async () => {
    const lock = new KeyedLock();
    const order: number[] = [];
    const p1 = lock.withLock('a', async () => {
      await delay(20);
      order.push(1);
    });
    const p2 = lock.withLock('a', async () => {
      await delay(1);
      order.push(2);
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it('runs calls for different keys concurrently, not serialized', async () => {
    const lock = new KeyedLock();
    const order: string[] = [];
    const pA = lock.withLock('a', async () => {
      await delay(20);
      order.push('a');
    });
    const pB = lock.withLock('b', async () => {
      await delay(1);
      order.push('b');
    });
    await Promise.all([pA, pB]);
    expect(order).toEqual(['b', 'a']);
  });

  it('propagates the function result', async () => {
    const lock = new KeyedLock();
    const result = await lock.withLock('a', async () => 42);
    expect(result).toBe(42);
  });

  it('propagates a thrown error to the caller', async () => {
    const lock = new KeyedLock();
    await expect(
      lock.withLock('a', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('continues processing subsequent calls after a prior call for the same key threw', async () => {
    const lock = new KeyedLock();
    const first = lock.withLock('a', async () => {
      throw new Error('boom');
    });
    const second = lock.withLock('a', async () => 'ok');
    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe('ok');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd cgremlin/core && pnpm test -- api/keyed-lock`
Expected: FAIL — cannot find module `../../src/api/keyed-lock`.

- [ ] **Step 3: Implement**

`cgremlin/core/src/api/keyed-lock.ts`:
```ts
export class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previousTail = this.tails.get(key) ?? Promise.resolve();
    const result = previousTail.then(fn, fn);
    // Store a tail that never rejects, so a prior failure never blocks
    // subsequent calls for the same key from running.
    this.tails.set(
      key,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd cgremlin/core && pnpm test -- api/keyed-lock`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Run typecheck and lint**

Run: `cd cgremlin/core && pnpm typecheck && pnpm lint`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add cgremlin/core/src/api/keyed-lock.ts cgremlin/core/test/api/keyed-lock.test.ts
git commit -m "feat(cgremlin-core): add KeyedLock for per-session-id request serialization"
```

---

### Task 2: `mapErrorToHttp` (error-to-status mapping)

**Files:**
- Create: `cgremlin/core/src/api/http-errors.ts`
- Test: `cgremlin/core/test/api/http-errors.test.ts`

**Interfaces:**
- Consumes: `SessionNotFoundError`, `SessionCorruptError`, `InvalidSessionIdError` from `../engine/session-store` (Phase 1a); `IllegalTransitionError` from `../schema/pipeline` (Phase 0) — all unmodified.
- Produces: `interface HttpError { status: number; body: { error: string } }` and `function mapErrorToHttp(err: unknown): HttpError`. Consumed by Task 3's request handler.

- [ ] **Step 1: Write the failing test**

`cgremlin/core/test/api/http-errors.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { mapErrorToHttp } from '../../src/api/http-errors';
import {
  SessionNotFoundError,
  InvalidSessionIdError,
  SessionCorruptError,
} from '../../src/engine/session-store';
import { IllegalTransitionError } from '../../src/schema/pipeline';

describe('mapErrorToHttp', () => {
  it('maps SessionNotFoundError to 404', () => {
    const result = mapErrorToHttp(new SessionNotFoundError('inv-1'));
    expect(result.status).toBe(404);
    expect(result.body.error).toContain('inv-1');
  });

  it('maps InvalidSessionIdError to 400', () => {
    const result = mapErrorToHttp(new InvalidSessionIdError('../bad'));
    expect(result.status).toBe(400);
  });

  it('maps IllegalTransitionError to 409', () => {
    const result = mapErrorToHttp(
      new IllegalTransitionError('investigation', 'findings', 'approved'),
    );
    expect(result.status).toBe(409);
  });

  it('maps SessionCorruptError to 500', () => {
    const result = mapErrorToHttp(new SessionCorruptError('inv-1', 'bad json'));
    expect(result.status).toBe(500);
  });

  it('maps an unknown Error to 500', () => {
    const result = mapErrorToHttp(new Error('something else'));
    expect(result.status).toBe(500);
    expect(result.body.error).toBe('something else');
  });

  it('maps a non-Error thrown value to 500', () => {
    const result = mapErrorToHttp('a string error');
    expect(result.status).toBe(500);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd cgremlin/core && pnpm test -- api/http-errors`
Expected: FAIL — cannot find module `../../src/api/http-errors`.

- [ ] **Step 3: Implement**

`cgremlin/core/src/api/http-errors.ts`:
```ts
export interface HttpError {
  status: number;
  body: { error: string };
}

export function mapErrorToHttp(err: unknown): HttpError {
  const name = err instanceof Error ? err.name : 'Error';
  const message = err instanceof Error ? err.message : String(err);
  switch (name) {
    case 'SessionNotFoundError':
      return { status: 404, body: { error: message } };
    case 'InvalidSessionIdError':
      return { status: 400, body: { error: message } };
    case 'IllegalTransitionError':
      return { status: 409, body: { error: message } };
    case 'SessionCorruptError':
      return { status: 500, body: { error: message } };
    default:
      return { status: 500, body: { error: message } };
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd cgremlin/core && pnpm test -- api/http-errors`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Run typecheck and lint**

Run: `cd cgremlin/core && pnpm typecheck && pnpm lint`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add cgremlin/core/src/api/http-errors.ts cgremlin/core/test/api/http-errors.test.ts
git commit -m "feat(cgremlin-core): add engine-error-to-HTTP-status mapping"
```

---

### Task 3: `createApiServer` (the HTTP router)

**Files:**
- Create: `cgremlin/core/src/api/server.ts`
- Test: `cgremlin/core/test/api/server.test.ts`

**Interfaces:**
- Consumes: `SessionStore` (Phase 1a), `WorkspaceManager`/`CreateWorkspaceParams` (Phase 1b), `KeyedLock` (Task 1), `mapErrorToHttp` (Task 2).
- Produces: `interface ApiServerDeps { sessionStore: SessionStore; workspaceManager: WorkspaceManager }` and `function createApiServer(deps: ApiServerDeps): http.Server`, exposing:
  - `GET /sessions` → `{ sessions: Session[] }`
  - `GET /sessions/:id` → `{ session: Session }` (404 via error mapping if missing)
  - `POST /sessions` (body: a full `Session` object) → saves it, `{ session }`, 201
  - `POST /sessions/:id/transition` (body: `{ to: string }`) → per-id-locked `sessionStore.transition`, `{ session }`, 200 (409 on an illegal transition)
  - `POST /workspaces` (body: `CreateWorkspaceParams`) → `{ mirrorPath }`, 201
  - `DELETE /workspaces` (body: `{ repoUrl, worktreePath, branchName }`) → 204, no body
  - Any other route → 404 `{ error: 'not found' }`
  This is the complete Phase 1c deliverable — the API boundary any future frontend builds against.

- [ ] **Step 1: Write the failing test**

`cgremlin/core/test/api/server.test.ts`:
```ts
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApiServer } from '../../src/api/server';
import { SessionStore } from '../../src/engine/session-store';
import { WorkspaceManager } from '../../src/workspace/workspace-manager';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { FakeGitRunner } from '../support/fake-git-runner';
import type { Session } from '../../src/schema/session';

let dir: string;
let socketPath: string;
let server: http.Server;

function request(
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
          resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : undefined });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-api-test-'));
  socketPath = path.join(dir, 'api.sock');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  const fs = new InMemoryFileSystem();
  const git = new FakeGitRunner();
  const sessionStore = new SessionStore(fs, '/sessions');
  const workspaceManager = new WorkspaceManager(git, fs, '/mirrors');
  server = createApiServer({ sessionStore, workspaceManager });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(socketPath, { force: true });
});

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    schemaVersion: 1,
    id: 'inv-test-1',
    mode: 'investigation',
    createdAt: '2026-08-28T10:00:00.000Z',
    workspace: { repoUrl: 'git@example.com:x/y.git' },
    lineage: { pipelineId: 'pl-1', parentSessionId: null, ticket: null },
    stageStatus: 'findings',
    ...overrides,
  } as Session;
}

describe('API server', () => {
  it('GET /sessions returns an empty list initially', async () => {
    const res = await request('GET', '/sessions');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessions: [] });
  });

  it('POST /sessions creates a session, then GET /sessions/:id returns it', async () => {
    const session = makeSession();
    const createRes = await request('POST', '/sessions', session);
    expect(createRes.status).toBe(201);
    const getRes = await request('GET', `/sessions/${session.id}`);
    expect(getRes.status).toBe(200);
    expect((getRes.body as { session: Session }).session).toEqual(session);
  });

  it('GET /sessions/:id returns 404 for an unknown id', async () => {
    const res = await request('GET', '/sessions/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('POST /sessions/:id/transition applies a legal transition', async () => {
    const session = makeSession();
    await request('POST', '/sessions', session);
    const res = await request('POST', `/sessions/${session.id}/transition`, { to: 'planning' });
    expect(res.status).toBe(200);
    expect((res.body as { session: Session }).session.stageStatus).toBe('planning');
  });

  it('POST /sessions/:id/transition returns 409 for an illegal transition', async () => {
    const session = makeSession();
    await request('POST', '/sessions', session);
    const res = await request('POST', `/sessions/${session.id}/transition`, { to: 'approved' });
    expect(res.status).toBe(409);
  });

  it('unknown routes return 404', async () => {
    const res = await request('GET', '/nope');
    expect(res.status).toBe(404);
  });

  it('POST /workspaces creates a workspace via WorkspaceManager', async () => {
    const res = await request('POST', '/workspaces', {
      repoUrl: 'git@github.com:org/repo.git',
      worktreePath: '/work/inv-1',
      branchName: 'main',
      baseRef: 'origin/main',
      mode: 'investigation',
    });
    expect(res.status).toBe(201);
    expect((res.body as { mirrorPath: string }).mirrorPath).toBe(
      '/mirrors/github.com-org-repo.git',
    );
  });

  it('DELETE /workspaces tears down a workspace via WorkspaceManager', async () => {
    const res = await request('DELETE', '/workspaces', {
      repoUrl: 'git@github.com:org/repo.git',
      worktreePath: '/work/inv-1',
      branchName: 'main',
    });
    expect(res.status).toBe(204);
  });

  it('concurrent transitions to the same target for the same session id are serialized: exactly one succeeds', async () => {
    const session = makeSession({ id: 'inv-race', stageStatus: 'findings' });
    await request('POST', '/sessions', session);
    const [r1, r2] = await Promise.all([
      request('POST', '/sessions/inv-race/transition', { to: 'planning' }),
      request('POST', '/sessions/inv-race/transition', { to: 'planning' }),
    ]);
    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd cgremlin/core && pnpm test -- api/server`
Expected: FAIL — cannot find module `../../src/api/server`.

- [ ] **Step 3: Implement**

`cgremlin/core/src/api/server.ts`:
```ts
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { SessionStore } from '../engine/session-store';
import type { WorkspaceManager, CreateWorkspaceParams } from '../workspace/workspace-manager';
import { KeyedLock } from './keyed-lock';
import { mapErrorToHttp } from './http-errors';

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

export interface ApiServerDeps {
  sessionStore: SessionStore;
  workspaceManager: WorkspaceManager;
}

export function createApiServer(deps: ApiServerDeps): http.Server {
  const lock = new KeyedLock();
  return http.createServer((req, res) => {
    void handleRequest(req, res, deps, lock);
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiServerDeps,
  lock: KeyedLock,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && parts.length === 1 && parts[0] === 'sessions') {
      const sessions = await deps.sessionStore.list();
      sendJson(res, 200, { sessions });
      return;
    }

    if (req.method === 'GET' && parts.length === 2 && parts[0] === 'sessions') {
      const session = await deps.sessionStore.load(parts[1]);
      sendJson(res, 200, { session });
      return;
    }

    if (req.method === 'POST' && parts.length === 1 && parts[0] === 'sessions') {
      const body = await readJsonBody(req);
      await deps.sessionStore.save(body as never);
      sendJson(res, 201, { session: body });
      return;
    }

    if (
      req.method === 'POST' &&
      parts.length === 3 &&
      parts[0] === 'sessions' &&
      parts[2] === 'transition'
    ) {
      const id = parts[1];
      const body = (await readJsonBody(req)) as { to: string };
      const updated = await lock.withLock(id, () => deps.sessionStore.transition(id, body.to));
      sendJson(res, 200, { session: updated });
      return;
    }

    if (req.method === 'POST' && parts.length === 1 && parts[0] === 'workspaces') {
      const body = (await readJsonBody(req)) as CreateWorkspaceParams;
      const mirrorPath = await deps.workspaceManager.createWorkspace(body);
      sendJson(res, 201, { mirrorPath });
      return;
    }

    if (req.method === 'DELETE' && parts.length === 1 && parts[0] === 'workspaces') {
      const body = (await readJsonBody(req)) as {
        repoUrl: string;
        worktreePath: string;
        branchName: string;
      };
      await deps.workspaceManager.removeWorkspace(body.repoUrl, body.worktreePath, body.branchName);
      sendJson(res, 204, undefined);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    const { status, body } = mapErrorToHttp(err);
    sendJson(res, status, body);
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd cgremlin/core && pnpm test -- api/server`
Expected: PASS — all 9 tests green, over real HTTP-over-Unix-socket requests.

- [ ] **Step 5: Run typecheck and lint**

Run: `cd cgremlin/core && pnpm typecheck && pnpm lint`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add cgremlin/core/src/api/server.ts cgremlin/core/test/api/server.test.ts
git commit -m "feat(cgremlin-core): add local HTTP-over-Unix-socket API server"
```

---

### Task 4: `listenOnSocket` (stale-socket-file cleanup)

**Files:**
- Create: `cgremlin/core/src/api/listen.ts`
- Test: `cgremlin/core/test/api/listen.test.ts`

**Interfaces:**
- Produces: `function listenOnSocket(server: http.Server, socketPath: string): Promise<void>` — removes a leftover socket file at `socketPath` (if any) before calling `server.listen`, so a stale file from an unclean prior shutdown doesn't cause a spurious `EADDRINUSE`. This is the function a future CLI/daemon entry point (not part of this plan) will call to actually start the Phase 1c server.

- [ ] **Step 1: Write the failing test**

`cgremlin/core/test/api/listen.test.ts`:
```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { listenOnSocket } from '../../src/api/listen';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-listen-test-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('listenOnSocket', () => {
  it('listens on a fresh socket path', async () => {
    const socketPath = path.join(dir, 'fresh.sock');
    const server = http.createServer((_req, res) => res.end('ok'));
    await listenOnSocket(server, socketPath);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('removes a stale socket file left over from an unclean shutdown before listening', async () => {
    const socketPath = path.join(dir, 'stale.sock');
    await writeFile(socketPath, '');
    const server = http.createServer((_req, res) => res.end('ok'));
    await listenOnSocket(server, socketPath);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd cgremlin/core && pnpm test -- api/listen`
Expected: FAIL — cannot find module `../../src/api/listen`.

- [ ] **Step 3: Implement**

`cgremlin/core/src/api/listen.ts`:
```ts
import { unlink } from 'node:fs/promises';
import type { Server } from 'node:http';

export async function listenOnSocket(server: Server, socketPath: string): Promise<void> {
  await unlink(socketPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd cgremlin/core && pnpm test -- api/listen`
Expected: PASS — both tests green.

- [ ] **Step 5: Run the full test suite, typecheck, and lint**

Run: `cd cgremlin/core && pnpm test && pnpm typecheck && pnpm lint`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add cgremlin/core/src/api/listen.ts cgremlin/core/test/api/listen.test.ts
git commit -m "feat(cgremlin-core): add stale-socket-file cleanup before listening"
```

---

## Definition of Done for Phase 1c

- `cd cgremlin/core && pnpm test && pnpm typecheck && pnpm lint` all pass locally.
- `KeyedLock`, `mapErrorToHttp`, `createApiServer`, and `listenOnSocket` all exist, are fully tested (including real HTTP-over-Unix-socket requests for the server), and export exactly the interfaces listed in each task above.
- The concurrency gap Phase 1a's final review flagged as a hard Phase 1c prerequisite is closed and directly tested (the "concurrent transitions... exactly one succeeds" test).
- No file outside `src/api/listen.ts` imports `node:fs`/`node:fs/promises` (beyond the pre-existing `src/fs/node-file-system.ts`) — verify with `grep -rn "node:fs" cgremlin/core/src` returning only those two files.
