# cgremlin/core Phase 1a: Session Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the stateful Session Store — the piece of the engine that persists `Session` objects to disk, enforces the Phase 0 pipeline transition table on every phase change, and is fully unit-testable with no real filesystem access (except one dedicated integration test proving the real adapter actually works). This is the first of four Phase 1 sub-plans (1a Session Store, 1b workspace isolation, 1c local API server, 1d agent-runner interface) that together implement the "Engine core" phase from the rebuild spec.

**Architecture:** A `SessionFileSystem` port (interface) with two implementations — `NodeFileSystem` (real disk, one integration test against a real temp directory) and `InMemoryFileSystem` (a fake used by every other test in this and later plans) — both verified against one shared contract test suite so they're provably interchangeable. On top of that, a pure `applyTransition` function (Session + target phase → new Session, enforcing Phase 0's `transitionPhase`) and a `SessionStore` class (save/load/list/transition) that composes the filesystem port and the pure transition function into the actual persistence engine.

**Tech Stack:** TypeScript, zod (already a dependency), vitest, Node's `node:fs/promises`/`node:os`/`node:path` (only inside `NodeFileSystem` and its test).

**Spec:** `cgremlin/core/docs/superpowers/specs/2026-08-28-cgremlin-core-rebuild-design.md` (section 2 "Engine (daemon)", section 3 "Session & Pipeline State Model", section 10 "Testing & Determinism Strategy")

## Global Constraints

- Fully local; no network calls, no hosted services.
- Every module must be unit-testable with no real filesystem, git, or subprocess access — the one exception is `NodeFileSystem`'s own test, which deliberately uses a real temp directory to prove the adapter works (per spec §10: "thin adapters get a real integration test; business logic gets fast fakes").
- All disk writes to `session.json` go through an atomic write-temp-then-rename, never a direct overwrite — partial writes must never be observable.
- No file outside `src/fs/node-file-system.ts` may import from `node:fs`, `node:fs/promises`, or any other real I/O module — every other module in this plan goes through the `SessionFileSystem` interface.
- Reuses Phase 0's exports exactly: `Session`, `parseSession`, `SessionMode` from `../schema/session`; `transitionPhase`, `IllegalTransitionError`, `InvestigationPhase`, `DevelopmentPhase`, `ReviewPhase` from `../schema/pipeline`. Do not modify Phase 0 files in this plan.
- Package manager is pnpm (v10.10.0), Node 24, already installed. Run all commands from `cgremlin/core/`.
- TDD: every task writes the failing test before the implementation.

---

### Task 1: `SessionFileSystem` interface, shared contract test, and `NodeFileSystem`

**Files:**
- Create: `cgremlin/core/src/fs/session-file-system.ts`
- Create: `cgremlin/core/src/fs/node-file-system.ts`
- Create: `cgremlin/core/test/support/file-system-contract.ts`
- Test: `cgremlin/core/test/fs/node-file-system.test.ts`

**Interfaces:**
- Produces: `SessionFileSystem` interface — `readFile(path): Promise<string>`, `writeFile(path, content): Promise<void>`, `rename(from, to): Promise<void>`, `readdir(path): Promise<string[]>`, `mkdir(path, options?: {recursive?: boolean}): Promise<void>`, `exists(path): Promise<boolean>`.
- Produces: `NodeFileSystem` class implementing `SessionFileSystem`.
- Produces: `testFileSystemContract(label: string, createFs: () => SessionFileSystem | Promise<SessionFileSystem>, makePath: (...segments: string[]) => string): void` — a reusable vitest suite (calls `describe`/`it` internally) any `SessionFileSystem` implementation must pass. Consumed by Task 2's `InMemoryFileSystem` test.

- [ ] **Step 1: Write the failing test**

`cgremlin/core/test/support/file-system-contract.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { SessionFileSystem } from '../../src/fs/session-file-system';

export function testFileSystemContract(
  label: string,
  createFs: () => SessionFileSystem | Promise<SessionFileSystem>,
  makePath: (...segments: string[]) => string,
): void {
  describe(`${label} (SessionFileSystem contract)`, () => {
    it('writes and reads back a file', async () => {
      const fs = await createFs();
      const path = makePath('a.txt');
      await fs.writeFile(path, 'hello');
      expect(await fs.readFile(path)).toBe('hello');
    });

    it('exists() is false for a path never written', async () => {
      const fs = await createFs();
      expect(await fs.exists(makePath('missing.txt'))).toBe(false);
    });

    it('exists() is true after writeFile', async () => {
      const fs = await createFs();
      const path = makePath('b.txt');
      await fs.writeFile(path, 'x');
      expect(await fs.exists(path)).toBe(true);
    });

    it('rename moves content from one path to another', async () => {
      const fs = await createFs();
      const from = makePath('c-tmp.txt');
      const to = makePath('c.txt');
      await fs.writeFile(from, 'moved');
      await fs.rename(from, to);
      expect(await fs.exists(from)).toBe(false);
      expect(await fs.readFile(to)).toBe('moved');
    });

    it('mkdir then readdir lists a file written inside it', async () => {
      const fs = await createFs();
      const dir = makePath('dir1');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(makePath('dir1', 'child.txt'), 'y');
      const entries = await fs.readdir(dir);
      expect(entries).toContain('child.txt');
    });

    it('readFile on a missing path rejects', async () => {
      const fs = await createFs();
      await expect(fs.readFile(makePath('nope.txt'))).rejects.toThrow();
    });
  });
}
```

`cgremlin/core/test/fs/node-file-system.test.ts`:
```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { NodeFileSystem } from '../../src/fs/node-file-system';
import { testFileSystemContract } from '../support/file-system-contract';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-fs-test-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

testFileSystemContract(
  'NodeFileSystem',
  () => new NodeFileSystem(),
  (...segments) => path.join(dir, ...segments),
);
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd cgremlin/core && pnpm test -- fs/node-file-system`
Expected: FAIL — cannot find module `../../src/fs/session-file-system` (and `node-file-system`).

- [ ] **Step 3: Implement the interface and the Node adapter**

`cgremlin/core/src/fs/session-file-system.ts`:
```ts
export interface SessionFileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;
}
```

`cgremlin/core/src/fs/node-file-system.ts`:
```ts
import { promises as fs } from 'node:fs';
import type { SessionFileSystem } from './session-file-system';

export class NodeFileSystem implements SessionFileSystem {
  async readFile(path: string): Promise<string> {
    return fs.readFile(path, 'utf8');
  }

  async writeFile(path: string, content: string): Promise<void> {
    await fs.writeFile(path, content, 'utf8');
  }

  async rename(from: string, to: string): Promise<void> {
    await fs.rename(from, to);
  }

  async readdir(path: string): Promise<string[]> {
    return fs.readdir(path);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await fs.mkdir(path, options);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd cgremlin/core && pnpm test -- fs/node-file-system`
Expected: PASS — all 6 contract tests green, running against a real temp directory.

- [ ] **Step 5: Run typecheck and lint**

Run: `cd cgremlin/core && pnpm typecheck && pnpm lint`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add cgremlin/core/src/fs/session-file-system.ts cgremlin/core/src/fs/node-file-system.ts \
  cgremlin/core/test/support/file-system-contract.ts cgremlin/core/test/fs/node-file-system.test.ts
git commit -m "feat(cgremlin-core): add SessionFileSystem port and NodeFileSystem adapter"
```

---

### Task 2: `InMemoryFileSystem` test double

**Files:**
- Create: `cgremlin/core/test/support/in-memory-file-system.ts`
- Test: `cgremlin/core/test/fs/in-memory-file-system.test.ts`

**Interfaces:**
- Consumes: `SessionFileSystem` (Task 1), `testFileSystemContract` (Task 1).
- Produces: `InMemoryFileSystem` class implementing `SessionFileSystem`, backed by in-process maps — no real I/O. Consumed by every test in Task 4 (`SessionStore`) and by later Phase 1 plans (1b, 1c) wherever a fake filesystem is needed.

- [ ] **Step 1: Write the failing test**

`cgremlin/core/test/fs/in-memory-file-system.test.ts`:
```ts
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { testFileSystemContract } from '../support/file-system-contract';

testFileSystemContract(
  'InMemoryFileSystem',
  () => new InMemoryFileSystem(),
  (...segments) => `/mem/${segments.join('/')}`,
);
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd cgremlin/core && pnpm test -- fs/in-memory-file-system`
Expected: FAIL — cannot find module `../support/in-memory-file-system`.

- [ ] **Step 3: Implement the fake**

`cgremlin/core/test/support/in-memory-file-system.ts`:
```ts
import type { SessionFileSystem } from '../../src/fs/session-file-system';

export class InMemoryFileSystem implements SessionFileSystem {
  private files = new Map<string, string>();
  private dirs = new Set<string>();

  async mkdir(path: string, _options?: { recursive?: boolean }): Promise<void> {
    this.dirs.add(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`ENOENT: no such file: ${path}`);
    }
    return content;
  }

  async rename(from: string, to: string): Promise<void> {
    const content = this.files.get(from);
    if (content === undefined) {
      throw new Error(`ENOENT: no such file: ${from}`);
    }
    this.files.delete(from);
    this.files.set(to, content);
  }

  async readdir(path: string): Promise<string[]> {
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const names = new Set<string>();
    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(prefix)) {
        const rest = filePath.slice(prefix.length);
        const [firstSegment] = rest.split('/');
        if (firstSegment) names.add(firstSegment);
      }
    }
    for (const dirPath of this.dirs) {
      if (dirPath.startsWith(prefix) && dirPath !== path) {
        const rest = dirPath.slice(prefix.length);
        const [firstSegment] = rest.split('/');
        if (firstSegment) names.add(firstSegment);
      }
    }
    return [...names];
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd cgremlin/core && pnpm test -- fs/in-memory-file-system`
Expected: PASS — all 6 contract tests green, running purely in-memory.

- [ ] **Step 5: Run typecheck and lint**

Run: `cd cgremlin/core && pnpm typecheck && pnpm lint`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add cgremlin/core/test/support/in-memory-file-system.ts cgremlin/core/test/fs/in-memory-file-system.test.ts
git commit -m "feat(cgremlin-core): add InMemoryFileSystem test double"
```

---

### Task 3: `applyTransition` (pure pipeline-transition function)

**Files:**
- Create: `cgremlin/core/src/engine/session-transition.ts`
- Test: `cgremlin/core/test/engine/session-transition.test.ts`

**Interfaces:**
- Consumes: `Session` from `../schema/session`; `transitionPhase`, `IllegalTransitionError`, `InvestigationPhase`, `DevelopmentPhase`, `ReviewPhase` from `../schema/pipeline` (all Phase 0, unmodified).
- Produces: `function applyTransition(session: Session, to: string): Session` — returns a new `Session` with `stageStatus` updated, or throws `IllegalTransitionError`. Pure: never mutates its input, never touches the filesystem. Consumed by Task 4's `SessionStore.transition`.

- [ ] **Step 1: Write the failing test**

`cgremlin/core/test/engine/session-transition.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { applyTransition } from '../../src/engine/session-transition';
import type { Session } from '../../src/schema/session';
import { IllegalTransitionError } from '../../src/schema/pipeline';

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

describe('applyTransition', () => {
  it('returns a new session with the updated stageStatus on a legal transition', () => {
    const session = makeSession({ stageStatus: 'findings' });
    const updated = applyTransition(session, 'planning');
    expect(updated.stageStatus).toBe('planning');
    expect(updated).not.toBe(session);
    expect(session.stageStatus).toBe('findings');
  });

  it('throws IllegalTransitionError on an illegal transition', () => {
    const session = makeSession({ stageStatus: 'findings' });
    expect(() => applyTransition(session, 'approved')).toThrow(IllegalTransitionError);
  });

  it('works for development-mode sessions using development phases', () => {
    const session = makeSession({ mode: 'development', stageStatus: 'active' });
    const updated = applyTransition(session, 'pr_opened');
    expect(updated.stageStatus).toBe('pr_opened');
  });

  it('works for review-mode sessions using review phases', () => {
    const session = makeSession({ mode: 'review', stageStatus: 'queued' });
    const updated = applyTransition(session, 'reviewing');
    expect(updated.stageStatus).toBe('reviewing');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd cgremlin/core && pnpm test -- engine/session-transition`
Expected: FAIL — cannot find module `../../src/engine/session-transition`.

- [ ] **Step 3: Implement**

`cgremlin/core/src/engine/session-transition.ts`:
```ts
import type { Session } from '../schema/session';
import {
  transitionPhase,
  type DevelopmentPhase,
  type InvestigationPhase,
  type ReviewPhase,
} from '../schema/pipeline';

export function applyTransition(session: Session, to: string): Session {
  switch (session.mode) {
    case 'investigation':
      return {
        ...session,
        stageStatus: transitionPhase('investigation', session.stageStatus, to as InvestigationPhase),
      };
    case 'development':
      return {
        ...session,
        stageStatus: transitionPhase('development', session.stageStatus, to as DevelopmentPhase),
      };
    case 'review':
      return {
        ...session,
        stageStatus: transitionPhase('review', session.stageStatus, to as ReviewPhase),
      };
  }
}
```

Note: the `as XPhase` casts on `to` are safe — `transitionPhase` validates `to` against the real per-mode transition table at runtime (via `canTransition`) regardless of its static type, and throws `IllegalTransitionError` if `to` isn't actually a legal target. `session.mode`-based narrowing means `session.stageStatus`'s type is already correct in each branch without a cast.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd cgremlin/core && pnpm test -- engine/session-transition`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Run typecheck and lint**

Run: `cd cgremlin/core && pnpm typecheck && pnpm lint`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add cgremlin/core/src/engine/session-transition.ts cgremlin/core/test/engine/session-transition.test.ts
git commit -m "feat(cgremlin-core): add pure applyTransition function"
```

---

### Task 4: `SessionStore` (save/load/list/transition)

**Files:**
- Create: `cgremlin/core/src/engine/session-store.ts`
- Test: `cgremlin/core/test/engine/session-store.test.ts`

**Interfaces:**
- Consumes: `SessionFileSystem` (Task 1), `InMemoryFileSystem` (Task 2, test-only), `applyTransition` (Task 3), `parseSession`/`Session` from `../schema/session`, `IllegalTransitionError` from `../schema/pipeline`.
- Produces:
  - `class SessionNotFoundError extends Error`
  - `class SessionCorruptError extends Error`
  - `class SessionStore { constructor(fs: SessionFileSystem, sessionsDir: string); save(session: Session): Promise<void>; load(id: string): Promise<Session>; list(): Promise<Session[]>; transition(id: string, to: string): Promise<Session>; }`
  This is the complete Phase 1a deliverable — Phase 1b/1c/1d will construct a `SessionStore` with a real `NodeFileSystem` and a real sessions directory.

- [ ] **Step 1: Write the failing test**

`cgremlin/core/test/engine/session-store.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { SessionStore, SessionNotFoundError, SessionCorruptError } from '../../src/engine/session-store';
import type { Session } from '../../src/schema/session';
import { IllegalTransitionError } from '../../src/schema/pipeline';

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

describe('SessionStore', () => {
  it('round-trips a session through save and load', async () => {
    const fs = new InMemoryFileSystem();
    const store = new SessionStore(fs, '/sessions');
    const session = makeSession();
    await store.save(session);
    const loaded = await store.load(session.id);
    expect(loaded).toEqual(session);
  });

  it('load throws SessionNotFoundError for an unknown id', async () => {
    const fs = new InMemoryFileSystem();
    const store = new SessionStore(fs, '/sessions');
    await expect(store.load('nope')).rejects.toThrow(SessionNotFoundError);
  });

  it('load throws SessionCorruptError for invalid JSON on disk', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/sessions/bad', { recursive: true });
    await fs.writeFile('/sessions/bad/session.json', '{not json');
    const store = new SessionStore(fs, '/sessions');
    await expect(store.load('bad')).rejects.toThrow(SessionCorruptError);
  });

  it('load throws SessionCorruptError for JSON that fails schema validation', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/sessions/bad2', { recursive: true });
    await fs.writeFile('/sessions/bad2/session.json', JSON.stringify({ mode: 'investigation' }));
    const store = new SessionStore(fs, '/sessions');
    await expect(store.load('bad2')).rejects.toThrow(SessionCorruptError);
  });

  it('list returns an empty array when the sessions directory does not exist yet', async () => {
    const fs = new InMemoryFileSystem();
    const store = new SessionStore(fs, '/sessions');
    expect(await store.list()).toEqual([]);
  });

  it('list returns every saved session', async () => {
    const fs = new InMemoryFileSystem();
    const store = new SessionStore(fs, '/sessions');
    await store.save(makeSession({ id: 'inv-a' }));
    await store.save(makeSession({ id: 'inv-b' }));
    const sessions = await store.list();
    expect(sessions.map((s) => s.id).sort()).toEqual(['inv-a', 'inv-b']);
  });

  it('transition applies a legal phase change and persists it', async () => {
    const fs = new InMemoryFileSystem();
    const store = new SessionStore(fs, '/sessions');
    await store.save(makeSession({ id: 'inv-c', stageStatus: 'findings' }));
    const updated = await store.transition('inv-c', 'planning');
    expect(updated.stageStatus).toBe('planning');
    const reloaded = await store.load('inv-c');
    expect(reloaded.stageStatus).toBe('planning');
  });

  it('transition rejects an illegal phase change and leaves the persisted session unchanged', async () => {
    const fs = new InMemoryFileSystem();
    const store = new SessionStore(fs, '/sessions');
    await store.save(makeSession({ id: 'inv-d', stageStatus: 'findings' }));
    await expect(store.transition('inv-d', 'approved')).rejects.toThrow(IllegalTransitionError);
    const reloaded = await store.load('inv-d');
    expect(reloaded.stageStatus).toBe('findings');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd cgremlin/core && pnpm test -- engine/session-store`
Expected: FAIL — cannot find module `../../src/engine/session-store`.

- [ ] **Step 3: Implement**

`cgremlin/core/src/engine/session-store.ts`:
```ts
import { parseSession, type Session } from '../schema/session';
import type { SessionFileSystem } from '../fs/session-file-system';
import { applyTransition } from './session-transition';

export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`No session found with id '${id}'`);
    this.name = 'SessionNotFoundError';
  }
}

export class SessionCorruptError extends Error {
  constructor(id: string, reason: string) {
    super(`Session '${id}' is corrupt: ${reason}`);
    this.name = 'SessionCorruptError';
  }
}

export class SessionStore {
  constructor(
    private readonly fs: SessionFileSystem,
    private readonly sessionsDir: string,
  ) {}

  private sessionDirPath(id: string): string {
    return `${this.sessionsDir}/${id}`;
  }

  private sessionFilePath(id: string): string {
    return `${this.sessionDirPath(id)}/session.json`;
  }

  async save(session: Session): Promise<void> {
    const validated = parseSession(session);
    const dir = this.sessionDirPath(validated.id);
    await this.fs.mkdir(dir, { recursive: true });
    const finalPath = this.sessionFilePath(validated.id);
    const tmpPath = `${finalPath}.tmp`;
    await this.fs.writeFile(tmpPath, JSON.stringify(validated, null, 2));
    await this.fs.rename(tmpPath, finalPath);
  }

  async load(id: string): Promise<Session> {
    const path = this.sessionFilePath(id);
    const exists = await this.fs.exists(path);
    if (!exists) {
      throw new SessionNotFoundError(id);
    }
    const raw = await this.fs.readFile(path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new SessionCorruptError(id, `invalid JSON: ${(err as Error).message}`);
    }
    try {
      return parseSession(parsed);
    } catch (err) {
      throw new SessionCorruptError(id, `schema validation failed: ${(err as Error).message}`);
    }
  }

  async list(): Promise<Session[]> {
    const exists = await this.fs.exists(this.sessionsDir);
    if (!exists) {
      return [];
    }
    const entries = await this.fs.readdir(this.sessionsDir);
    const sessions: Session[] = [];
    for (const id of entries) {
      sessions.push(await this.load(id));
    }
    return sessions;
  }

  async transition(id: string, to: string): Promise<Session> {
    const session = await this.load(id);
    const updated = applyTransition(session, to);
    await this.save(updated);
    return updated;
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd cgremlin/core && pnpm test -- engine/session-store`
Expected: PASS — all 8 tests green.

- [ ] **Step 5: Run the full test suite, typecheck, and lint**

Run: `cd cgremlin/core && pnpm test && pnpm typecheck && pnpm lint`
Expected: all green (Phase 0's 23 tests + this plan's 6 + 6 + 4 + 8 = 47 total).

- [ ] **Step 6: Commit**

```bash
git add cgremlin/core/src/engine/session-store.ts cgremlin/core/test/engine/session-store.test.ts
git commit -m "feat(cgremlin-core): add SessionStore (save/load/list/transition)"
```

---

## Definition of Done for Phase 1a

- `cd cgremlin/core && pnpm test && pnpm typecheck && pnpm lint` all pass locally, 47 tests total.
- `SessionFileSystem`, `NodeFileSystem`, `InMemoryFileSystem`, `applyTransition`, and `SessionStore` all exist, are fully tested, and export exactly the interfaces listed in each task above — these are what Phase 1b (workspace isolation) and Phase 1c (API server) will build on.
- No file outside `src/fs/node-file-system.ts` imports a real I/O module — verify with `grep -rn "from 'node:fs" cgremlin/core/src` returning only that one file.
