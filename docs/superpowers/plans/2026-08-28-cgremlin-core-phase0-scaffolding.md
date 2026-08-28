# cgremlin/core Phase 0: Scaffolding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `cgremlin/core` TypeScript project (toolchain, lint/test/CI) and implement the typed, versioned session schema, the per-mode pipeline transition table, and a migration stub for legacy `session.json` files — the foundation Phase 1 (engine core) builds on.

**Architecture:** A standalone TypeScript package at `cgremlin/core/` inside the existing `context-gremlin` repo (not a workspace member — its own `package.json`/lockfile), built with `zod` for runtime-validated types and `vitest` for tests. No engine, API, or agent-runner code yet — this phase only produces the data model (session schema, pipeline transitions) and the tooling to build/test/lint it in CI.

**Tech Stack:** TypeScript (CommonJS, strict mode), zod, vitest, ESLint (flat config) + typescript-eslint, pnpm, GitHub Actions.

**Spec:** `cgremlin/core/docs/superpowers/specs/2026-08-28-cgremlin-core-rebuild-design.md` (sections 1, 3, 10, 11 — Phase 0 scope)

## Global Constraints

- Fully local tool; this phase adds no network calls, no hosted services.
- `cgremlin/core` lives inside the `context-gremlin` repo at `cgremlin/core/`, structured so it is extractable into its own repo later without restructuring.
- `mode` (`review` | `investigation` | `development`) is the only source of truth for session type — never inferred from a directory-name prefix.
- Every module in this phase is unit-testable with no real filesystem, git, or subprocess access.
- TDD: every task below writes the failing test before the implementation.
- Package manager is pnpm (already installed on this machine at v10.10.0; Node 24 available).

---

### Task 1: Project scaffolding & toolchain smoke test

**Files:**
- Create: `cgremlin/core/package.json`
- Create: `cgremlin/core/tsconfig.json`
- Create: `cgremlin/core/eslint.config.js`
- Create: `cgremlin/core/vitest.config.ts`
- Create: `cgremlin/core/src/index.ts`
- Test: `cgremlin/core/test/smoke.test.ts`

**Interfaces:**
- Produces: `VERSION: string` exported from `cgremlin/core/src/index.ts`, and a working `pnpm typecheck` / `pnpm lint` / `pnpm test` toolchain that every later task relies on.

- [ ] **Step 1: Create the package directory and write the failing smoke test**

```bash
mkdir -p cgremlin/core/src cgremlin/core/test
```

`cgremlin/core/test/smoke.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/index';

describe('toolchain smoke test', () => {
  it('exposes a package version string', () => {
    expect(VERSION).toBe('0.0.1');
  });
});
```

- [ ] **Step 2: Write the toolchain config files**

`cgremlin/core/package.json`:
```json
{
  "name": "@cgremlin/core",
  "version": "0.0.1",
  "private": true,
  "engines": {
    "node": ">=20"
  },
  "packageManager": "pnpm@10.10.0",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint ."
  },
  "dependencies": {
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@eslint/js": "^9.13.0",
    "eslint": "^9.13.0",
    "typescript": "^5.6.3",
    "typescript-eslint": "^8.11.0",
    "vitest": "^2.1.4"
  }
}
```

`cgremlin/core/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "CommonJS",
    "moduleResolution": "Node",
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

`cgremlin/core/eslint.config.js`:
```js
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
      },
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
);
```

`cgremlin/core/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
```

`cgremlin/core/src/index.ts`:
```ts
export const VERSION = '0.0.1';
```

- [ ] **Step 3: Install dependencies**

Run: `cd cgremlin/core && pnpm install`
Expected: lockfile `cgremlin/core/pnpm-lock.yaml` created, `node_modules` installed with no errors.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd cgremlin/core && pnpm test`
Expected: PASS — `toolchain smoke test > exposes a package version string`

- [ ] **Step 5: Run typecheck and lint and confirm both pass**

Run: `cd cgremlin/core && pnpm typecheck && pnpm lint`
Expected: both exit 0 with no errors.

- [ ] **Step 6: Commit**

```bash
git add cgremlin/core/package.json cgremlin/core/pnpm-lock.yaml cgremlin/core/tsconfig.json \
  cgremlin/core/eslint.config.js cgremlin/core/vitest.config.ts cgremlin/core/src/index.ts \
  cgremlin/core/test/smoke.test.ts cgremlin/core/.gitignore
git commit -m "chore(cgremlin-core): scaffold TypeScript project with lint/test toolchain"
```

(Before committing, create `cgremlin/core/.gitignore` containing `node_modules/` and `dist/` — see Task 1a below.)

---

### Task 1a: Add `.gitignore`

**Files:**
- Create: `cgremlin/core/.gitignore`

- [ ] **Step 1: Write the file**

`cgremlin/core/.gitignore`:
```
node_modules/
dist/
```

- [ ] **Step 2: Verify `node_modules` is not tracked**

Run: `cd cgremlin/core && git status --short`
Expected: no `node_modules/` entries listed.

(This step's file is included in Task 1's commit above.)

---

### Task 2: Session schema (zod) and types

**Files:**
- Create: `cgremlin/core/src/schema/session.ts`
- Test: `cgremlin/core/test/schema/session.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure new module).
- Produces:
  - `SessionModeSchema: ZodEnum<['review', 'investigation', 'development']>`
  - `type SessionMode = 'review' | 'investigation' | 'development'`
  - `SessionSchema: ZodObject<...>` validating `{ schemaVersion: 1, id, mode, createdAt, workspace: { repoUrl, worktreePath?, branch? }, lineage: { pipelineId, parentSessionId, ticket }, stageStatus }`
  - `type Session` (inferred from `SessionSchema`)
  - `function parseSession(data: unknown): Session`
  These are consumed by Task 4 (the legacy migrator).

- [ ] **Step 1: Write the failing test**

`cgremlin/core/test/schema/session.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseSession, SessionSchema } from '../../src/schema/session';

const validSession = {
  schemaVersion: 1 as const,
  id: 'inv-grace-frontend-20260828-101500',
  mode: 'investigation' as const,
  createdAt: '2026-08-28T10:15:00.000Z',
  workspace: {
    repoUrl: 'git@github.com:aplaceformom/grace-frontend.git',
  },
  lineage: {
    pipelineId: 'pl-HB-1234-20260828',
    parentSessionId: null,
    ticket: 'HB-1234',
  },
  stageStatus: 'active',
};

describe('SessionSchema', () => {
  it('accepts a valid session', () => {
    expect(() => parseSession(validSession)).not.toThrow();
  });

  it('rejects an invalid mode', () => {
    const invalid = { ...validSession, mode: 'bogus' };
    expect(() => parseSession(invalid)).toThrow();
  });

  it('rejects a session with an empty lineage.pipelineId', () => {
    const invalid = {
      ...validSession,
      lineage: { ...validSession.lineage, pipelineId: '' },
    };
    expect(() => parseSession(invalid)).toThrow();
  });

  it('exposes the parsed session mode via SessionSchema.parse', () => {
    const parsed = SessionSchema.parse(validSession);
    expect(parsed.mode).toBe('investigation');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd cgremlin/core && pnpm test -- schema/session`
Expected: FAIL — cannot find module `../../src/schema/session`.

- [ ] **Step 3: Implement the schema**

`cgremlin/core/src/schema/session.ts`:
```ts
import { z } from 'zod';

export const SessionModeSchema = z.enum(['review', 'investigation', 'development']);
export type SessionMode = z.infer<typeof SessionModeSchema>;

export const SessionSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  mode: SessionModeSchema,
  createdAt: z.string().datetime(),
  workspace: z.object({
    repoUrl: z.string().min(1),
    worktreePath: z.string().min(1).optional(),
    branch: z.string().min(1).optional(),
  }),
  lineage: z.object({
    pipelineId: z.string().min(1),
    parentSessionId: z.string().min(1).nullable(),
    ticket: z.string().min(1).nullable(),
  }),
  stageStatus: z.string().min(1),
});

export type Session = z.infer<typeof SessionSchema>;

export function parseSession(data: unknown): Session {
  return SessionSchema.parse(data);
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd cgremlin/core && pnpm test -- schema/session`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Run typecheck and lint**

Run: `cd cgremlin/core && pnpm typecheck && pnpm lint`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add cgremlin/core/src/schema/session.ts cgremlin/core/test/schema/session.test.ts
git commit -m "feat(cgremlin-core): add typed, versioned session schema"
```

---

### Task 3: Pipeline phase types and transition table

**Files:**
- Create: `cgremlin/core/src/schema/pipeline.ts`
- Test: `cgremlin/core/test/schema/pipeline.test.ts`

**Interfaces:**
- Consumes: `SessionMode` from `cgremlin/core/src/schema/session.ts` (Task 2).
- Produces:
  - `INVESTIGATION_PHASES`, `DEVELOPMENT_PHASES`, `REVIEW_PHASES` (readonly string tuples) and their derived types `InvestigationPhase`, `DevelopmentPhase`, `ReviewPhase`.
  - `class IllegalTransitionError extends Error`
  - `function canTransition<M extends SessionMode>(mode: M, from: PhaseFor<M>, to: PhaseFor<M>): boolean`
  - `function transitionPhase<M extends SessionMode>(mode: M, from: PhaseFor<M>, to: PhaseFor<M>): PhaseFor<M>` — throws `IllegalTransitionError` on an illegal transition.
  Phase 1 (engine core) will call `transitionPhase` from the API layer to enforce every state change.

- [ ] **Step 1: Write the failing test**

`cgremlin/core/test/schema/pipeline.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  canTransition,
  IllegalTransitionError,
  transitionPhase,
} from '../../src/schema/pipeline';

describe('pipeline transition table', () => {
  it('allows investigation findings -> planning', () => {
    expect(canTransition('investigation', 'findings', 'planning')).toBe(true);
  });

  it('rejects skipping straight from findings to approved', () => {
    expect(canTransition('investigation', 'findings', 'approved')).toBe(false);
  });

  it('rejects promoting to development before plan approval', () => {
    // Guards the exact gap in today's bash implementation: nothing stops
    // --develop before approval except a bypassable shell `if`.
    expect(
      canTransition('investigation', 'planning', 'promoted_to_development'),
    ).toBe(false);
  });

  it('transitionPhase returns the target phase on a legal transition', () => {
    expect(transitionPhase('review', 'queued', 'reviewing')).toBe('reviewing');
  });

  it('transitionPhase throws IllegalTransitionError on an illegal transition', () => {
    expect(() => transitionPhase('review', 'queued', 'approved')).toThrow(
      IllegalTransitionError,
    );
  });

  it('review supports the changes_requested -> reviewing re-review loop', () => {
    expect(canTransition('review', 'changes_requested', 'reviewing')).toBe(true);
  });

  it('terminal phases have no outgoing transitions', () => {
    expect(canTransition('development', 'merged', 'active')).toBe(false);
    expect(canTransition('review', 'approved', 'reviewing')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd cgremlin/core && pnpm test -- schema/pipeline`
Expected: FAIL — cannot find module `../../src/schema/pipeline`.

- [ ] **Step 3: Implement the transition table**

`cgremlin/core/src/schema/pipeline.ts`:
```ts
import type { SessionMode } from './session';

export const INVESTIGATION_PHASES = [
  'findings',
  'planning',
  'plan_ready',
  'approved',
  'promoted_to_development',
] as const;
export type InvestigationPhase = (typeof INVESTIGATION_PHASES)[number];

export const DEVELOPMENT_PHASES = [
  'active',
  'pr_opened',
  'superseded',
  'merged',
  'abandoned',
] as const;
export type DevelopmentPhase = (typeof DEVELOPMENT_PHASES)[number];

export const REVIEW_PHASES = [
  'queued',
  'reviewing',
  'ready',
  'approved',
  'changes_requested',
  'dismissed',
] as const;
export type ReviewPhase = (typeof REVIEW_PHASES)[number];

export type PhaseFor<M extends SessionMode> = M extends 'investigation'
  ? InvestigationPhase
  : M extends 'development'
    ? DevelopmentPhase
    : ReviewPhase;

const TRANSITIONS: Record<SessionMode, Record<string, readonly string[]>> = {
  investigation: {
    findings: ['planning'],
    planning: ['plan_ready'],
    plan_ready: ['approved'],
    approved: ['promoted_to_development'],
    promoted_to_development: [],
  },
  development: {
    active: ['pr_opened', 'abandoned'],
    pr_opened: ['superseded', 'abandoned'],
    superseded: ['merged', 'abandoned'],
    merged: [],
    abandoned: [],
  },
  review: {
    queued: ['reviewing'],
    reviewing: ['ready', 'dismissed'],
    ready: ['approved', 'changes_requested', 'dismissed'],
    changes_requested: ['reviewing', 'dismissed'],
    approved: [],
    dismissed: [],
  },
};

export class IllegalTransitionError extends Error {
  constructor(mode: SessionMode, from: string, to: string) {
    super(`Cannot transition ${mode} session from '${from}' to '${to}'`);
    this.name = 'IllegalTransitionError';
  }
}

export function canTransition<M extends SessionMode>(
  mode: M,
  from: PhaseFor<M>,
  to: PhaseFor<M>,
): boolean {
  return TRANSITIONS[mode][from]?.includes(to) ?? false;
}

export function transitionPhase<M extends SessionMode>(
  mode: M,
  from: PhaseFor<M>,
  to: PhaseFor<M>,
): PhaseFor<M> {
  if (!canTransition(mode, from, to)) {
    throw new IllegalTransitionError(mode, from, to);
  }
  return to;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd cgremlin/core && pnpm test -- schema/pipeline`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Run typecheck and lint**

Run: `cd cgremlin/core && pnpm typecheck && pnpm lint`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add cgremlin/core/src/schema/pipeline.ts cgremlin/core/test/schema/pipeline.test.ts
git commit -m "feat(cgremlin-core): add per-mode pipeline transition table"
```

---

### Task 4: Legacy `session.json` migration stub

**Files:**
- Create: `cgremlin/core/src/migrate/legacy-session-migrator.ts`
- Test: `cgremlin/core/test/migrate/legacy-session-migrator.test.ts`

**Interfaces:**
- Consumes: `Session`, `parseSession`, `SessionModeSchema` from `cgremlin/core/src/schema/session.ts` (Task 2).
- Produces:
  - `class LegacySessionMigrationError extends Error`
  - `function migrateLegacySession(raw: unknown): Session` — validates and maps a legacy `~/.cgremlin/sessions/<id>/session.json` object (fields: `id`, `mode`, `project`, `created`, `status?`, `lineage?: { pipeline_id?, parent_session_id?, ticket? }`) onto the new `Session` shape, throwing `LegacySessionMigrationError` on missing/invalid required fields.

- [ ] **Step 1: Write the failing test**

`cgremlin/core/test/migrate/legacy-session-migrator.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  LegacySessionMigrationError,
  migrateLegacySession,
} from '../../src/migrate/legacy-session-migrator';

const legacyInvestigationSession = {
  id: 'inv-grace-frontend-20260710-143000',
  mode: 'investigation',
  project: 'git@github.com:aplaceformom/grace-frontend.git',
  created: '2026-07-10T14:30:00Z',
  status: 'active',
  lineage: {
    pipeline_id: 'pl-HB-1234-20260710',
    parent_session_id: null,
    ticket: 'HB-1234',
  },
};

describe('migrateLegacySession', () => {
  it('maps a legacy investigation session.json to the new Session shape', () => {
    const migrated = migrateLegacySession(legacyInvestigationSession);
    expect(migrated).toMatchObject({
      schemaVersion: 1,
      id: 'inv-grace-frontend-20260710-143000',
      mode: 'investigation',
      workspace: { repoUrl: 'git@github.com:aplaceformom/grace-frontend.git' },
      lineage: {
        pipelineId: 'pl-HB-1234-20260710',
        parentSessionId: null,
        ticket: 'HB-1234',
      },
      stageStatus: 'active',
    });
  });

  it('defaults stageStatus to "active" when legacy status is missing', () => {
    const { status: _status, ...withoutStatus } = legacyInvestigationSession;
    const migrated = migrateLegacySession(withoutStatus);
    expect(migrated.stageStatus).toBe('active');
  });

  it('defaults lineage to session-id-derived values when legacy lineage is missing', () => {
    const { lineage: _lineage, ...withoutLineage } = legacyInvestigationSession;
    const migrated = migrateLegacySession(withoutLineage);
    expect(migrated.lineage.pipelineId).toBe(legacyInvestigationSession.id);
    expect(migrated.lineage.parentSessionId).toBeNull();
    expect(migrated.lineage.ticket).toBeNull();
  });

  it('throws LegacySessionMigrationError when a required field is missing', () => {
    const { id: _id, ...withoutId } = legacyInvestigationSession;
    expect(() => migrateLegacySession(withoutId)).toThrow(LegacySessionMigrationError);
  });

  it('throws LegacySessionMigrationError on an invalid created timestamp', () => {
    const invalid = { ...legacyInvestigationSession, created: 'not-a-date' };
    expect(() => migrateLegacySession(invalid)).toThrow(LegacySessionMigrationError);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cd cgremlin/core && pnpm test -- migrate/legacy-session-migrator`
Expected: FAIL — cannot find module `../../src/migrate/legacy-session-migrator`.

- [ ] **Step 3: Implement the migrator**

`cgremlin/core/src/migrate/legacy-session-migrator.ts`:
```ts
import { z } from 'zod';
import { parseSession, Session, SessionMode, SessionModeSchema } from '../schema/session';

const LegacySessionSchema = z.object({
  id: z.string().min(1),
  mode: SessionModeSchema,
  project: z.string().min(1),
  created: z.string().min(1),
  status: z.string().min(1).optional(),
  lineage: z
    .object({
      pipeline_id: z.string().min(1).optional(),
      parent_session_id: z.string().min(1).nullable().optional(),
      ticket: z.string().min(1).nullable().optional(),
    })
    .optional(),
});

export class LegacySessionMigrationError extends Error {}

export function migrateLegacySession(raw: unknown): Session {
  const parsedLegacy = LegacySessionSchema.safeParse(raw);
  if (!parsedLegacy.success) {
    throw new LegacySessionMigrationError(
      `Legacy session.json failed validation: ${parsedLegacy.error.message}`,
    );
  }
  const legacy = parsedLegacy.data;

  const createdAtDate = new Date(legacy.created);
  if (Number.isNaN(createdAtDate.getTime())) {
    throw new LegacySessionMigrationError(
      `Legacy session.json has an invalid 'created' timestamp: ${legacy.created}`,
    );
  }

  const candidate = {
    schemaVersion: 1 as const,
    id: legacy.id,
    mode: legacy.mode as SessionMode,
    createdAt: createdAtDate.toISOString(),
    workspace: {
      repoUrl: legacy.project,
    },
    lineage: {
      pipelineId: legacy.lineage?.pipeline_id ?? legacy.id,
      parentSessionId: legacy.lineage?.parent_session_id ?? null,
      ticket: legacy.lineage?.ticket ?? null,
    },
    stageStatus: legacy.status ?? 'active',
  };

  return parseSession(candidate);
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cd cgremlin/core && pnpm test -- migrate/legacy-session-migrator`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Run the full test suite, typecheck, and lint**

Run: `cd cgremlin/core && pnpm test && pnpm typecheck && pnpm lint`
Expected: all green (16 tests total across Tasks 1-4).

- [ ] **Step 6: Commit**

```bash
git add cgremlin/core/src/migrate/legacy-session-migrator.ts \
  cgremlin/core/test/migrate/legacy-session-migrator.test.ts
git commit -m "feat(cgremlin-core): add legacy session.json migration stub"
```

---

### Task 5: CI workflow

**Files:**
- Create: `.github/workflows/cgremlin-core-ci.yml` (repo root — GitHub Actions only discovers workflows there)

**Interfaces:**
- Consumes: the `pnpm typecheck` / `pnpm lint` / `pnpm test` scripts from Task 1, exercised against everything built in Tasks 2-4.
- Produces: nothing consumed by later tasks — this closes out Phase 0.

- [ ] **Step 1: Write the workflow file**

`.github/workflows/cgremlin-core-ci.yml`:
```yaml
name: cgremlin-core CI

on:
  push:
    paths:
      - 'cgremlin/core/**'
      - '.github/workflows/cgremlin-core-ci.yml'
  pull_request:
    paths:
      - 'cgremlin/core/**'
      - '.github/workflows/cgremlin-core-ci.yml'

defaults:
  run:
    working-directory: cgremlin/core

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10.10.0
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: 'pnpm'
          cache-dependency-path: cgremlin/core/pnpm-lock.yaml
      - run: pnpm install --frozen-lockfile
      - run: pnpm run typecheck
      - run: pnpm run lint
      - run: pnpm run test
```

- [ ] **Step 2: Validate the YAML syntax locally**

Run: `python3 -c "import yaml, sys; yaml.safe_load(open('.github/workflows/cgremlin-core-ci.yml'))" && echo "valid YAML"`
Expected: prints `valid YAML` with no exception.

- [ ] **Step 3: Verify the exact command sequence CI will run, locally**

Run: `cd cgremlin/core && pnpm install --frozen-lockfile && pnpm run typecheck && pnpm run lint && pnpm run test`
Expected: all four commands exit 0, mirroring exactly what the workflow will run on push.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/cgremlin-core-ci.yml
git commit -m "ci: add cgremlin-core test/lint/typecheck workflow"
```

- [ ] **Step 5: Push and confirm the workflow runs**

Run: `git push` (to a branch, or per your normal workflow)
Expected: on GitHub, the "cgremlin-core CI" workflow appears in the Actions tab and passes. If it doesn't trigger, double check the `paths:` filters match the pushed branch's changed files.

---

## Definition of Done for Phase 0

- `cd cgremlin/core && pnpm test && pnpm typecheck && pnpm lint` all pass locally.
- The GitHub Actions workflow `cgremlin-core CI` passes on push.
- `cgremlin/core/src/schema/session.ts`, `cgremlin/core/src/schema/pipeline.ts`, and `cgremlin/core/src/migrate/legacy-session-migrator.ts` exist, are fully unit-tested, and export the interfaces listed in each task above — these are exactly what Phase 1 (engine core) will import.
