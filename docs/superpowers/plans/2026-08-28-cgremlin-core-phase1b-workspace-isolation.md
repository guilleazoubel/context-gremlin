# cgremlin/core Phase 1b: Workspace Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build git-worktree-based workspace isolation — one bare/mirror clone per repo, one worktree+branch per session, and typed permission-guard generation (replacing the old bash tool's hand-written `.claude/settings.local.json` blobs) — fully unit-testable with fakes, plus one real integration test proving the git adapter actually works.

**Architecture:** A `GitRunner` port (interface) with `NodeGitRunner` (real, shells out to `git` via `node:child_process`, one integration test against a real temp repo) and `FakeGitRunner` (records calls, returns queued responses, used everywhere else). On top: pure orchestration functions — `mirrorDirName`/`ensureMirror` (one mirror clone per repo, fetched not re-cloned), `createWorktree`/`removeWorktree` (git worktree add/remove), and `renderPermissionSettings`/`writePermissionSettings` (typed per-mode allow/deny config, written via Phase 1a's `SessionFileSystem`). `WorkspaceManager` composes all three into the session-creation/teardown operations Phase 1c's API server will call.

**Tech Stack:** TypeScript, vitest, `node:child_process` (only inside `NodeGitRunner`), Phase 1a's `SessionFileSystem`/`InMemoryFileSystem` (reused unmodified).

**Spec:** `cgremlin/core/docs/superpowers/specs/2026-08-28-cgremlin-core-rebuild-design.md` (section 4 "Workspace Isolation")

## Global Constraints

- Fully local tool — no hosted backend for the engine. Git operations against a repo's own remote (`clone --mirror`, `fetch`) are expected, ordinary git behavior and are not affected by this constraint.
- Every module must be unit-testable with no real git or subprocess access — the one deliberate exception is `NodeGitRunner`'s own test, which uses a real temp git repo (same pattern as Phase 1a's `NodeFileSystem` test).
- No file outside `src/git/node-git-runner.ts` may import `node:child_process` or spawn a real subprocess.
- Reuses Phase 1a's `SessionFileSystem`/`InMemoryFileSystem` exactly, unmodified, for every file operation in this phase — no new filesystem abstraction.
- Permission-guard content must preserve the legacy bash tool's exact allow/deny lists per mode (documented below), preserving "the way of working" — not inventing new policy.
- Package manager is pnpm (v10.10.0), Node 24. Run all commands from `cgremlin/core/`.
- TDD: every task writes the failing test before the implementation.

---

### Task 1: `GitRunner` interface and `NodeGitRunner`

**Files:**
- Create: `cgremlin/core/src/git/git-runner.ts`
- Create: `cgremlin/core/src/git/node-git-runner.ts`
- Test: `cgremlin/core/test/git/node-git-runner.test.ts`

**Interfaces:**
- Produces: `GitRunner` interface — `run(args: string[], options: { cwd: string }): Promise<{ stdout: string; stderr: string }>`, rejects on non-zero exit.
- Produces: `NodeGitRunner` class implementing `GitRunner` via `node:child_process`'s `execFile`.

- [ ] **Step 1: Write the failing test**

`cgremlin/core/test/git/node-git-runner.test.ts`:
```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NodeGitRunner } from '../../src/git/node-git-runner';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-git-test-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('NodeGitRunner', () => {
  it('runs a real git command and returns its stdout', async () => {
    const git = new NodeGitRunner();
    await git.run(['init'], { cwd: dir });
    const { stdout } = await git.run(['rev-parse', '--is-inside-work-tree'], { cwd: dir });
    expect(stdout.trim()).toBe('true');
  });

  it('rejects when the git command fails', async () => {
    const git = new NodeGitRunner();
    await expect(git.run(['not-a-real-git-command'], { cwd: dir })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd cgremlin/core && pnpm test -- git/node-git-runner`
Expected: FAIL — cannot find module `../../src/git/git-runner` (and `node-git-runner`).

- [ ] **Step 3: Implement**

`cgremlin/core/src/git/git-runner.ts`:
```ts
export interface GitRunner {
  run(args: string[], options: { cwd: string }): Promise<{ stdout: string; stderr: string }>;
}
```

`cgremlin/core/src/git/node-git-runner.ts`:
```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitRunner } from './git-runner';

const execFileAsync = promisify(execFile);

export class NodeGitRunner implements GitRunner {
  async run(args: string[], options: { cwd: string }): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd: options.cwd });
    return { stdout, stderr };
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd cgremlin/core && pnpm test -- git/node-git-runner`
Expected: PASS — both tests green, against a real temp git repo.

- [ ] **Step 5: Run typecheck and lint**

Run: `cd cgremlin/core && pnpm typecheck && pnpm lint`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add cgremlin/core/src/git/git-runner.ts cgremlin/core/src/git/node-git-runner.ts \
  cgremlin/core/test/git/node-git-runner.test.ts
git commit -m "feat(cgremlin-core): add GitRunner port and NodeGitRunner adapter"
```

---

### Task 2: `FakeGitRunner` test double

**Files:**
- Create: `cgremlin/core/test/support/fake-git-runner.ts`
- Test: `cgremlin/core/test/support/fake-git-runner.test.ts`

**Interfaces:**
- Consumes: `GitRunner` (Task 1).
- Produces: `FakeGitRunner` class implementing `GitRunner` — records every call as `{ args: string[], cwd: string }` in a public `calls` array, and returns queued responses (or a default empty success) via `queueResponse(response)`. Consumed by every test in Tasks 3-6 that needs to assert which git commands were issued without running real git.

- [ ] **Step 1: Write the failing test**

`cgremlin/core/test/support/fake-git-runner.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { FakeGitRunner } from './fake-git-runner';

describe('FakeGitRunner', () => {
  it('records the args and cwd of each call', async () => {
    const git = new FakeGitRunner();
    await git.run(['status'], { cwd: '/repo' });
    expect(git.calls).toEqual([{ args: ['status'], cwd: '/repo' }]);
  });

  it('returns queued responses in order', async () => {
    const git = new FakeGitRunner();
    git.queueResponse({ stdout: 'first', stderr: '' });
    git.queueResponse({ stdout: 'second', stderr: '' });
    const a = await git.run(['a'], { cwd: '/repo' });
    const b = await git.run(['b'], { cwd: '/repo' });
    expect(a.stdout).toBe('first');
    expect(b.stdout).toBe('second');
  });

  it('returns a default empty success response when no response is queued', async () => {
    const git = new FakeGitRunner();
    const result = await git.run(['status'], { cwd: '/repo' });
    expect(result).toEqual({ stdout: '', stderr: '' });
  });

  it('throws a queued Error instead of returning it', async () => {
    const git = new FakeGitRunner();
    git.queueResponse(new Error('git failed'));
    await expect(git.run(['bad'], { cwd: '/repo' })).rejects.toThrow('git failed');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd cgremlin/core && pnpm test -- support/fake-git-runner`
Expected: FAIL — cannot find module `./fake-git-runner`.

- [ ] **Step 3: Implement**

`cgremlin/core/test/support/fake-git-runner.ts`:
```ts
import type { GitRunner } from '../../src/git/git-runner';

export interface RecordedGitCall {
  args: string[];
  cwd: string;
}

export class FakeGitRunner implements GitRunner {
  readonly calls: RecordedGitCall[] = [];
  private responses: Array<{ stdout: string; stderr: string } | Error> = [];

  queueResponse(response: { stdout: string; stderr: string } | Error): void {
    this.responses.push(response);
  }

  async run(args: string[], options: { cwd: string }): Promise<{ stdout: string; stderr: string }> {
    this.calls.push({ args, cwd: options.cwd });
    const next = this.responses.shift();
    if (next instanceof Error) {
      throw next;
    }
    return next ?? { stdout: '', stderr: '' };
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd cgremlin/core && pnpm test -- support/fake-git-runner`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Run typecheck and lint**

Run: `cd cgremlin/core && pnpm typecheck && pnpm lint`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add cgremlin/core/test/support/fake-git-runner.ts cgremlin/core/test/support/fake-git-runner.test.ts
git commit -m "feat(cgremlin-core): add FakeGitRunner test double"
```

---

### Task 3: Repo mirror (`mirrorDirName` + `ensureMirror`)

**Files:**
- Create: `cgremlin/core/src/workspace/repo-mirror.ts`
- Test: `cgremlin/core/test/workspace/repo-mirror.test.ts`

**Interfaces:**
- Consumes: `GitRunner` (Task 1), `FakeGitRunner` (Task 2, test-only), `SessionFileSystem`/`InMemoryFileSystem` (Phase 1a, unmodified).
- Produces:
  - `function mirrorDirName(repoUrl: string): string` — pure, deterministic, filesystem-safe slug (e.g. `git@github.com:org/repo.git` and `https://github.com/org/repo.git` both → `github.com-org-repo.git`).
  - `function ensureMirror(git: GitRunner, fs: SessionFileSystem, mirrorsDir: string, repoUrl: string): Promise<string>` — clones (`git clone --mirror`) if the mirror doesn't exist yet, otherwise fetches (`git fetch --all --prune`); returns the mirror's absolute path. Consumed by Task 6's `WorkspaceManager`.

- [ ] **Step 1: Write the failing test**

`cgremlin/core/test/workspace/repo-mirror.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { mirrorDirName, ensureMirror } from '../../src/workspace/repo-mirror';
import { FakeGitRunner } from '../support/fake-git-runner';
import { InMemoryFileSystem } from '../support/in-memory-file-system';

describe('mirrorDirName', () => {
  it('converts an SSH-style git URL to a filesystem-safe mirror directory name', () => {
    expect(mirrorDirName('git@github.com:aplaceformom/grace-frontend.git')).toBe(
      'github.com-aplaceformom-grace-frontend.git',
    );
  });

  it('converts an HTTPS-style git URL to a filesystem-safe mirror directory name', () => {
    expect(mirrorDirName('https://github.com/aplaceformom/grace-frontend.git')).toBe(
      'github.com-aplaceformom-grace-frontend.git',
    );
  });
});

describe('ensureMirror', () => {
  it('clones the mirror when it does not exist yet', async () => {
    const git = new FakeGitRunner();
    const fs = new InMemoryFileSystem();
    const mirrorPath = await ensureMirror(git, fs, '/mirrors', 'git@github.com:org/repo.git');
    expect(mirrorPath).toBe('/mirrors/github.com-org-repo.git');
    expect(git.calls).toEqual([
      {
        args: ['clone', '--mirror', 'git@github.com:org/repo.git', '/mirrors/github.com-org-repo.git'],
        cwd: '/mirrors',
      },
    ]);
  });

  it('fetches instead of cloning when the mirror already exists', async () => {
    const git = new FakeGitRunner();
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/mirrors/github.com-org-repo.git', { recursive: true });
    const mirrorPath = await ensureMirror(git, fs, '/mirrors', 'git@github.com:org/repo.git');
    expect(mirrorPath).toBe('/mirrors/github.com-org-repo.git');
    expect(git.calls).toEqual([
      { args: ['fetch', '--all', '--prune'], cwd: '/mirrors/github.com-org-repo.git' },
    ]);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd cgremlin/core && pnpm test -- workspace/repo-mirror`
Expected: FAIL — cannot find module `../../src/workspace/repo-mirror`.

- [ ] **Step 3: Implement**

`cgremlin/core/src/workspace/repo-mirror.ts`:
```ts
import type { GitRunner } from '../git/git-runner';
import type { SessionFileSystem } from '../fs/session-file-system';

export function mirrorDirName(repoUrl: string): string {
  const slug = repoUrl
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/^git@/i, '')
    .replace(/[:/]/g, '-')
    .replace(/\.git$/i, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-');
  return `${slug}.git`;
}

export async function ensureMirror(
  git: GitRunner,
  fs: SessionFileSystem,
  mirrorsDir: string,
  repoUrl: string,
): Promise<string> {
  const mirrorPath = `${mirrorsDir}/${mirrorDirName(repoUrl)}`;
  const exists = await fs.exists(mirrorPath);
  if (!exists) {
    await fs.mkdir(mirrorsDir, { recursive: true });
    await git.run(['clone', '--mirror', repoUrl, mirrorPath], { cwd: mirrorsDir });
  } else {
    await git.run(['fetch', '--all', '--prune'], { cwd: mirrorPath });
  }
  return mirrorPath;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd cgremlin/core && pnpm test -- workspace/repo-mirror`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Run typecheck and lint**

Run: `cd cgremlin/core && pnpm typecheck && pnpm lint`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add cgremlin/core/src/workspace/repo-mirror.ts cgremlin/core/test/workspace/repo-mirror.test.ts
git commit -m "feat(cgremlin-core): add repo mirror clone/fetch orchestration"
```

---

### Task 4: Worktree create/remove

**Files:**
- Create: `cgremlin/core/src/workspace/worktree.ts`
- Test: `cgremlin/core/test/workspace/worktree.test.ts`

**Interfaces:**
- Consumes: `GitRunner` (Task 1), `FakeGitRunner` (Task 2, test-only).
- Produces:
  - `function createWorktree(git: GitRunner, mirrorPath: string, worktreePath: string, branchName: string, baseRef: string): Promise<void>` — runs `git worktree add <worktreePath> -b <branchName> <baseRef>` with `cwd` at the mirror.
  - `function removeWorktree(git: GitRunner, mirrorPath: string, worktreePath: string): Promise<void>` — runs `git worktree remove <worktreePath> --force` with `cwd` at the mirror.
  Both consumed by Task 6's `WorkspaceManager`.

- [ ] **Step 1: Write the failing test**

`cgremlin/core/test/workspace/worktree.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { createWorktree, removeWorktree } from '../../src/workspace/worktree';
import { FakeGitRunner } from '../support/fake-git-runner';

describe('createWorktree', () => {
  it('runs git worktree add with the branch and base ref, cwd at the mirror', async () => {
    const git = new FakeGitRunner();
    await createWorktree(git, '/mirrors/repo.git', '/work/inv-1', 'feature/x', 'origin/main');
    expect(git.calls).toEqual([
      {
        args: ['worktree', 'add', '/work/inv-1', '-b', 'feature/x', 'origin/main'],
        cwd: '/mirrors/repo.git',
      },
    ]);
  });
});

describe('removeWorktree', () => {
  it('runs git worktree remove --force, cwd at the mirror', async () => {
    const git = new FakeGitRunner();
    await removeWorktree(git, '/mirrors/repo.git', '/work/inv-1');
    expect(git.calls).toEqual([
      { args: ['worktree', 'remove', '/work/inv-1', '--force'], cwd: '/mirrors/repo.git' },
    ]);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd cgremlin/core && pnpm test -- workspace/worktree`
Expected: FAIL — cannot find module `../../src/workspace/worktree`.

- [ ] **Step 3: Implement**

`cgremlin/core/src/workspace/worktree.ts`:
```ts
import type { GitRunner } from '../git/git-runner';

export async function createWorktree(
  git: GitRunner,
  mirrorPath: string,
  worktreePath: string,
  branchName: string,
  baseRef: string,
): Promise<void> {
  await git.run(['worktree', 'add', worktreePath, '-b', branchName, baseRef], {
    cwd: mirrorPath,
  });
}

export async function removeWorktree(
  git: GitRunner,
  mirrorPath: string,
  worktreePath: string,
): Promise<void> {
  await git.run(['worktree', 'remove', worktreePath, '--force'], { cwd: mirrorPath });
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd cgremlin/core && pnpm test -- workspace/worktree`
Expected: PASS — both tests green.

- [ ] **Step 5: Run typecheck and lint**

Run: `cd cgremlin/core && pnpm typecheck && pnpm lint`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add cgremlin/core/src/workspace/worktree.ts cgremlin/core/test/workspace/worktree.test.ts
git commit -m "feat(cgremlin-core): add git worktree create/remove orchestration"
```

---

### Task 5: Permission guard (typed per-mode allow/deny config)

**Files:**
- Create: `cgremlin/core/src/workspace/permission-guard.ts`
- Test: `cgremlin/core/test/workspace/permission-guard.test.ts`

**Interfaces:**
- Consumes: `SessionFileSystem`/`InMemoryFileSystem` (Phase 1a), `SessionMode` from `../schema/session-mode` (Phase 0).
- Produces:
  - `interface PermissionConfig { allow?: string[]; deny?: string[] }`
  - `const DEFAULT_PERMISSIONS: Record<SessionMode, PermissionConfig>` — the exact per-mode allow/deny lists the legacy bash tool uses (investigation and development allow-lists, review deny-list; see the exact values in Step 3 below, preserved verbatim from `bin/cgremlin`).
  - `function renderPermissionSettings(config: PermissionConfig): string` — pure, returns pretty-printed JSON `{ "permissions": { "allow"?: [...], "deny"?: [...] } }`, omitting empty keys.
  - `function writePermissionSettings(fs: SessionFileSystem, worktreePath: string, mode: SessionMode): Promise<void>` — writes `${worktreePath}/.claude/settings.local.json` using `DEFAULT_PERMISSIONS[mode]`. Consumed by Task 6's `WorkspaceManager`.

- [ ] **Step 1: Write the failing test**

`cgremlin/core/test/workspace/permission-guard.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { renderPermissionSettings, writePermissionSettings } from '../../src/workspace/permission-guard';
import { InMemoryFileSystem } from '../support/in-memory-file-system';

describe('renderPermissionSettings', () => {
  it('renders an allow list', () => {
    const json = renderPermissionSettings({ allow: ['Bash(foo)'] });
    expect(JSON.parse(json)).toEqual({ permissions: { allow: ['Bash(foo)'] } });
  });

  it('renders a deny list', () => {
    const json = renderPermissionSettings({ deny: ['Bash(bar)'] });
    expect(JSON.parse(json)).toEqual({ permissions: { deny: ['Bash(bar)'] } });
  });

  it('omits empty allow/deny keys', () => {
    const json = renderPermissionSettings({});
    expect(JSON.parse(json)).toEqual({ permissions: {} });
  });
});

describe('writePermissionSettings', () => {
  it('writes the investigation mode allow-list to .claude/settings.local.json', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/work/inv-1', { recursive: true });
    await writePermissionSettings(fs, '/work/inv-1', 'investigation');
    const content = await fs.readFile('/work/inv-1/.claude/settings.local.json');
    const parsed = JSON.parse(content);
    expect(parsed.permissions.allow).toContain('Bash(cgremlin --plan-start *)');
  });

  it('writes the review mode deny-list to .claude/settings.local.json', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/work/pr-1', { recursive: true });
    await writePermissionSettings(fs, '/work/pr-1', 'review');
    const content = await fs.readFile('/work/pr-1/.claude/settings.local.json');
    const parsed = JSON.parse(content);
    expect(parsed.permissions.deny).toContain('Bash(git push:*)');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd cgremlin/core && pnpm test -- workspace/permission-guard`
Expected: FAIL — cannot find module `../../src/workspace/permission-guard`.

- [ ] **Step 3: Implement**

`cgremlin/core/src/workspace/permission-guard.ts`:
```ts
import type { SessionFileSystem } from '../fs/session-file-system';
import type { SessionMode } from '../schema/session-mode';

export interface PermissionConfig {
  allow?: string[];
  deny?: string[];
}

export const DEFAULT_PERMISSIONS: Record<SessionMode, PermissionConfig> = {
  investigation: {
    allow: [
      'Bash(cgremlin --develop *)',
      'Bash(cgremlin --approve-plan *)',
      'Bash(cgremlin --plan-start *)',
      'Bash(cgremlin --plan-ready *)',
      'Bash(cgremlin --run-local *)',
      'Bash(cgremlin --stop-local *)',
      'Bash(cgremlin --agent-state *)',
      'Bash(cgremlin --agent-note *)',
    ],
  },
  development: {
    allow: [
      'Bash(cgremlin --reply-comment *)',
      'Bash(cgremlin --resolve-comment *)',
      'Bash(cgremlin --pr-ready *)',
      'Bash(cgremlin --commit-fix *)',
      'Bash(cgremlin --push-fix *)',
      'Bash(cgremlin --run-local *)',
      'Bash(cgremlin --stop-local *)',
      'Bash(cgremlin --agent-state *)',
      'Bash(cgremlin --agent-note *)',
    ],
  },
  review: {
    deny: [
      'Bash(gh pr review:*)',
      'Bash(gh pr comment:*)',
      'Bash(gh pr merge:*)',
      'Bash(gh pr close:*)',
      'Bash(gh pr edit:*)',
      'Bash(gh pr create:*)',
      'Bash(gh api:*--method*)',
      'Bash(git push:*)',
      'Bash(git commit:*)',
    ],
  },
};

export function renderPermissionSettings(config: PermissionConfig): string {
  const permissions: Record<string, string[]> = {};
  if (config.allow?.length) permissions.allow = config.allow;
  if (config.deny?.length) permissions.deny = config.deny;
  return JSON.stringify({ permissions }, null, 2);
}

export async function writePermissionSettings(
  fs: SessionFileSystem,
  worktreePath: string,
  mode: SessionMode,
): Promise<void> {
  const dir = `${worktreePath}/.claude`;
  await fs.mkdir(dir, { recursive: true });
  const content = renderPermissionSettings(DEFAULT_PERMISSIONS[mode]);
  await fs.writeFile(`${dir}/settings.local.json`, content);
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd cgremlin/core && pnpm test -- workspace/permission-guard`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Run typecheck and lint**

Run: `cd cgremlin/core && pnpm typecheck && pnpm lint`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add cgremlin/core/src/workspace/permission-guard.ts cgremlin/core/test/workspace/permission-guard.test.ts
git commit -m "feat(cgremlin-core): add typed per-mode permission guard generation"
```

---

### Task 6: `WorkspaceManager` (composition)

**Files:**
- Create: `cgremlin/core/src/workspace/workspace-manager.ts`
- Test: `cgremlin/core/test/workspace/workspace-manager.test.ts`

**Interfaces:**
- Consumes: `GitRunner`/`FakeGitRunner`, `ensureMirror`/`mirrorDirName` (Task 3), `createWorktree`/`removeWorktree` (Task 4), `writePermissionSettings` (Task 5), `SessionFileSystem`/`InMemoryFileSystem`, `SessionMode`.
- Produces: `class WorkspaceManager { constructor(git: GitRunner, fs: SessionFileSystem, mirrorsDir: string); createWorkspace(params: CreateWorkspaceParams): Promise<string>; removeWorkspace(repoUrl: string, worktreePath: string): Promise<void>; }` where `CreateWorkspaceParams = { repoUrl: string; worktreePath: string; branchName: string; baseRef: string; mode: SessionMode }`. This is the complete Phase 1b deliverable — Phase 1c's API server will construct one `WorkspaceManager` and call it from session-creation/teardown request handlers.

- [ ] **Step 1: Write the failing test**

`cgremlin/core/test/workspace/workspace-manager.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { WorkspaceManager } from '../../src/workspace/workspace-manager';
import { FakeGitRunner } from '../support/fake-git-runner';
import { InMemoryFileSystem } from '../support/in-memory-file-system';

describe('WorkspaceManager', () => {
  it('createWorkspace ensures the mirror, creates the worktree, and writes permission settings', async () => {
    const git = new FakeGitRunner();
    const fs = new InMemoryFileSystem();
    const manager = new WorkspaceManager(git, fs, '/mirrors');
    const mirrorPath = await manager.createWorkspace({
      repoUrl: 'git@github.com:org/repo.git',
      worktreePath: '/work/inv-1',
      branchName: 'main',
      baseRef: 'origin/main',
      mode: 'investigation',
    });
    expect(mirrorPath).toBe('/mirrors/github.com-org-repo.git');
    expect(git.calls).toEqual([
      {
        args: ['clone', '--mirror', 'git@github.com:org/repo.git', '/mirrors/github.com-org-repo.git'],
        cwd: '/mirrors',
      },
      {
        args: ['worktree', 'add', '/work/inv-1', '-b', 'main', 'origin/main'],
        cwd: '/mirrors/github.com-org-repo.git',
      },
    ]);
    const settings = await fs.readFile('/work/inv-1/.claude/settings.local.json');
    expect(JSON.parse(settings).permissions.allow).toContain('Bash(cgremlin --plan-start *)');
  });

  it('removeWorkspace runs git worktree remove against the derived mirror path', async () => {
    const git = new FakeGitRunner();
    const fs = new InMemoryFileSystem();
    const manager = new WorkspaceManager(git, fs, '/mirrors');
    await manager.removeWorkspace('git@github.com:org/repo.git', '/work/inv-1');
    expect(git.calls).toEqual([
      { args: ['worktree', 'remove', '/work/inv-1', '--force'], cwd: '/mirrors/github.com-org-repo.git' },
    ]);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd cgremlin/core && pnpm test -- workspace/workspace-manager`
Expected: FAIL — cannot find module `../../src/workspace/workspace-manager`.

- [ ] **Step 3: Implement**

`cgremlin/core/src/workspace/workspace-manager.ts`:
```ts
import type { GitRunner } from '../git/git-runner';
import type { SessionFileSystem } from '../fs/session-file-system';
import type { SessionMode } from '../schema/session-mode';
import { ensureMirror, mirrorDirName } from './repo-mirror';
import { createWorktree, removeWorktree } from './worktree';
import { writePermissionSettings } from './permission-guard';

export interface CreateWorkspaceParams {
  repoUrl: string;
  worktreePath: string;
  branchName: string;
  baseRef: string;
  mode: SessionMode;
}

export class WorkspaceManager {
  constructor(
    private readonly git: GitRunner,
    private readonly fs: SessionFileSystem,
    private readonly mirrorsDir: string,
  ) {}

  async createWorkspace(params: CreateWorkspaceParams): Promise<string> {
    const mirrorPath = await ensureMirror(this.git, this.fs, this.mirrorsDir, params.repoUrl);
    await createWorktree(
      this.git,
      mirrorPath,
      params.worktreePath,
      params.branchName,
      params.baseRef,
    );
    await writePermissionSettings(this.fs, params.worktreePath, params.mode);
    return mirrorPath;
  }

  async removeWorkspace(repoUrl: string, worktreePath: string): Promise<void> {
    const mirrorPath = `${this.mirrorsDir}/${mirrorDirName(repoUrl)}`;
    await removeWorktree(this.git, mirrorPath, worktreePath);
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd cgremlin/core && pnpm test -- workspace/workspace-manager`
Expected: PASS — both tests green.

- [ ] **Step 5: Run the full test suite, typecheck, and lint**

Run: `cd cgremlin/core && pnpm test && pnpm typecheck && pnpm lint`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add cgremlin/core/src/workspace/workspace-manager.ts cgremlin/core/test/workspace/workspace-manager.test.ts
git commit -m "feat(cgremlin-core): add WorkspaceManager composing mirror/worktree/permissions"
```

---

## Definition of Done for Phase 1b

- `cd cgremlin/core && pnpm test && pnpm typecheck && pnpm lint` all pass locally.
- `GitRunner`, `NodeGitRunner`, `FakeGitRunner`, `mirrorDirName`/`ensureMirror`, `createWorktree`/`removeWorktree`, `renderPermissionSettings`/`DEFAULT_PERMISSIONS`/`writePermissionSettings`, and `WorkspaceManager` all exist, are fully tested, and export exactly the interfaces listed in each task above — these are what Phase 1c (API server) will import and call from session-creation/teardown request handlers.
- No file outside `src/git/node-git-runner.ts` imports `node:child_process` — verify with `grep -rn "node:child_process" cgremlin/core/src` returning only that one file.
