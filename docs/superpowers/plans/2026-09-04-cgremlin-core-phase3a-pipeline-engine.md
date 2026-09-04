# cgremlin/core Phase 3a: Pipeline Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the orchestration layer that drives a session through its pipeline: stage runs that build a brief + prompt + guard, run the agent through `AgentRunner`, inspect the artifacts left in the session directory, and perform the resulting transition; the plan-approval gate; promotion of an approved investigation into a development session; review and re-review runs with the legacy `REVIEW.md` contract; and the API routes for all of it.

**Architecture:** Pure modules first (`schema` v2 + migration, `prompts`, `artifacts`, `plan-gate`, `events`), then one impure orchestrator (`StageRunner`: one agent turn per call, completion keyed off `onExit`, never off `sendPrompt` resolving), then `PipelineService` use cases composing store + workspace + stage runner + git, then the HTTP routes. Every transition still goes through `SessionStore.transition` and therefore the Phase 0 transition tables; the service never writes `stageStatus` directly. Agents never call back into the engine (spec ruling 1): completion is inferred from files (`FINDINGS.md`, `PLAN.md` `## Review Status`, `REVIEW.md` non-empty, `rereview_summary`).

**Tech Stack:** TypeScript, zod, vitest, `node:http`. No new dependency.

**Spec:** `cgremlin/core/docs/superpowers/specs/2026-09-04-cgremlin-core-phase3-pipelines-design.md` (sections 2, 3, 4, 6, 7). Legacy behavior it reproduces: `bin/cgremlin` at commit `ef665e2` — `write_investigate_brief` (:14162), `write_develop_brief` (:14326), `develop_start` gate (:14464), `launch_headless_review` prompt (:14557), `rereview_pr` archive loop and prompt (:14668, :14727).

## Verified Ground Truth (confirmed live 2026-09-04 — re-verify before deviating)

- `claude --help` lists `--add-dir <directories...>` ("Additional directories to allow tool access to"), `--resume <session-id>`, `--output-format stream-json`, `--permission-mode <mode>`, `--model <model>`.
- `ClaudeCodeRunner` already resumes via `--resume <id>` captured from the `result` event (Phase 2a); this plan only adds seeding that id from `SessionContext.resumeId` and passing `--add-dir`.
- Legacy success rule for a review run is exactly `rc == 0 && [ -s REVIEW.md ]` (bin/cgremlin:14560–14563).
- Legacy archive rule: `version=1; while [ -f REVIEW-v${version}.md ]; do version++; done; cp REVIEW.md REVIEW-v${version}.md` (bin/cgremlin:14668–14672).
- Legacy plan gate: promote allowed iff `plan_review.phase == approved`, or `drive_to_completion == true && plan_review.phase == plan_ready` (bin/cgremlin:14464–14476).

## Global Constraints

- Node 24, pnpm 10.10.0. Run every command from `cgremlin/core/`. `pnpm test && pnpm typecheck && pnpm lint` must be green at every commit.
- No real subprocess, network, or credential in tests. Use `FakeAgentRunner`, `InMemoryFileSystem`, `FakeGitRunner`. The one exception is the existing `ClaudeCodeRunner` fixture-CLI test, which stays fixture-only.
- `mode` is the only source of truth for session type. Never infer it from an id prefix.
- The engine issues **no** GitHub-mutating command (spec ruling 2). Phase 3a issues no `gh` command at all.
- Agents never call back into the engine (spec ruling 1). Briefs must not mention any `cgremlin --…` command.
- Every state change goes through `SessionStore.transition`; never assign `stageStatus` directly outside `applyTransition`.
- Every task: failing test → RED → implement → GREEN → `pnpm typecheck && pnpm lint` → commit. Commit messages follow the repo's `feat(cgremlin-core): …` / `test(cgremlin-core): …` convention and end with the Co-Authored-By trailer used in recent commits.
- Work happens in a dedicated git worktree branched from `mission-control-pr-orchestrator` (the supervising session tells the executor its path). Never commit to `mission-control-pr-orchestrator` directly.

## File Structure

Create:
- `src/schema/session.ts` (modify — v2 union, `migrateV1ToV2`, `parseSession` accepting v1 and v2)
- `src/schema/pipeline.ts` (modify — `failed` review phase, `ready → reviewing`)
- `src/schema/stage.ts` — `StageName`, `LastRun`, `Agent`, `Pr` zod schemas + types
- `src/migrate/legacy-session-migrator.ts` (modify — `plan_review`, `intent`, `pr`, `reviewed_sha`)
- `src/agent/agent-runner.ts` (modify — `SessionContext.additionalDirs`, `SessionContext.resumeId`, optional `getResumeId`)
- `src/agent/claude-code-runner.ts` (modify — seed resume id, `--add-dir`, `getResumeId`)
- `test/support/fake-agent-runner.ts` (modify — `getResumeId`, `setResumeId`)
- `src/workspace/permission-guard.ts` (modify — drop dead `cgremlin --…` allow-lists)
- `src/pipeline/prompts.ts` — brief and prompt templates
- `src/pipeline/artifacts.ts` — artifact evaluators, `nextReviewVersion`, `parseRereviewSummary`
- `src/pipeline/plan-gate.ts` — `canPromote`, `PlanGateError`
- `src/engine/events.ts` — `EngineEvents`
- `src/pipeline/stage-runner.ts` — `StageRunner`, `RunInProgressError`, `WorkspaceMissingError`
- `src/pipeline/pipeline-service.ts` — `PipelineService` and its errors
- `src/workspace/workspace-in-use.ts` — `findSessionsUsingWorktree`, `WorkspaceInUseError`
- `src/api/server.ts`, `src/api/http-errors.ts`, `src/api/validation.ts` (modify — routes, mappings, request schemas)
- Tests mirror each `src` path under `test/`.

---

### Task 1: Schema v2, transition-table additions, v1→v2 migration

**Files:**
- Create: `src/schema/stage.ts`
- Modify: `src/schema/pipeline.ts`
- Modify: `src/schema/session.ts`
- Modify: `src/migrate/legacy-session-migrator.ts`
- Test: `test/schema/pipeline.test.ts`, `test/schema/session.test.ts`, `test/migrate/legacy-session-migrator.test.ts`

**Interfaces:**
- Consumes: existing `INVESTIGATION_PHASES`, `DEVELOPMENT_PHASES`, `REVIEW_PHASES`, `SessionModeSchema`.
- Produces:
  - `src/schema/stage.ts`: `STAGE_NAMES = ['findings','plan','develop','review','rereview'] as const`, `StageNameSchema`, `type StageName`, `LastRunSchema`, `type LastRun`, `AgentSchema`, `type AgentInfo`, `PrSchema`, `type PrInfo`.
  - `src/schema/pipeline.ts`: `REVIEW_PHASES` now includes `'failed'`; `reviewing → failed`, `failed → reviewing | dismissed`, `ready → reviewing` allowed.
  - `src/schema/session.ts`: `SessionV1Schema`, `SessionSchema` (v2, `schemaVersion: 2`), `type Session` (v2), `migrateV1ToV2(v1: SessionV1): Session`, `parseSession(data: unknown): Session` accepting either version and always returning v2.
  - Every existing test and fixture that builds a `Session` literal with `schemaVersion: 1` keeps passing through `parseSession` (migration path) — but new code in this plan always writes v2.

- [ ] **Step 1: Write the failing tests**

Append to `test/schema/pipeline.test.ts`:
```ts
describe('review phase additions (phase 3a)', () => {
  it('allows reviewing -> failed, failed -> reviewing, failed -> dismissed', () => {
    expect(canTransition('review', 'reviewing', 'failed')).toBe(true);
    expect(canTransition('review', 'failed', 'reviewing')).toBe(true);
    expect(canTransition('review', 'failed', 'dismissed')).toBe(true);
  });
  it('allows ready -> reviewing so an updated PR can be re-reviewed before a human acts', () => {
    expect(canTransition('review', 'ready', 'reviewing')).toBe(true);
  });
  it('still rejects failed -> ready (a failed run must be re-run, not declared ready)', () => {
    expect(canTransition('review', 'failed', 'ready')).toBe(false);
  });
});
```

Append to `test/schema/session.test.ts`:
```ts
import { migrateV1ToV2, parseSession } from '../../src/schema/session';

const v1Investigation = {
  schemaVersion: 1 as const,
  id: 'inv-1',
  mode: 'investigation' as const,
  createdAt: '2026-09-04T10:00:00.000Z',
  workspace: { repoUrl: 'git@github.com:acme/app.git' },
  lineage: { pipelineId: 'p1', parentSessionId: null, ticket: 'APP-1' },
  stageStatus: 'findings' as const,
};

describe('schema v2', () => {
  it('parseSession upgrades a v1 investigation document to v2 with defaults', () => {
    const s = parseSession(v1Investigation);
    expect(s.schemaVersion).toBe(2);
    expect(s.agent).toBeNull();
    expect(s.lastRun).toBeNull();
    expect(s.pr).toBeNull();
    if (s.mode !== 'investigation') throw new Error('mode changed');
    expect(s.intent).toBe('investigate_only');
    expect(s.driveToCompletion).toBe(false);
  });

  it('parseSession upgrades a v1 review document with reviewVersion 0', () => {
    const s = parseSession({ ...v1Investigation, id: 'r1', mode: 'review', stageStatus: 'queued' });
    if (s.mode !== 'review') throw new Error('mode changed');
    expect(s.reviewVersion).toBe(0);
  });

  it('migrateV1ToV2 is idempotent through parseSession (v2 in, same v2 out)', () => {
    const once = parseSession(v1Investigation);
    expect(parseSession(once)).toEqual(once);
  });

  it('accepts a full v2 document with agent, lastRun and pr populated', () => {
    const s = parseSession({
      ...migrateV1ToV2(v1Investigation),
      agent: { runner: 'claude-code', resumeId: 'abc' },
      lastRun: {
        stage: 'findings', startedAt: '2026-09-04T10:00:00.000Z', finishedAt: null,
        exitCode: null, signal: null, outcome: 'running', error: null,
      },
      pr: { repo: 'acme/app', number: 12, url: 'https://github.com/acme/app/pull/12',
            headSha: null, reviewedSha: null, title: null, author: null },
    });
    expect(s.agent?.resumeId).toBe('abc');
    expect(s.lastRun?.outcome).toBe('running');
    expect(s.pr?.number).toBe(12);
  });

  it('rejects an unknown schemaVersion', () => {
    expect(() => parseSession({ ...v1Investigation, schemaVersion: 3 })).toThrow();
  });

  it('rejects a v2 review document whose stageStatus is not a review phase', () => {
    expect(() =>
      parseSession({ ...migrateV1ToV2({ ...v1Investigation, mode: 'review', stageStatus: 'queued' }), stageStatus: 'planning' }),
    ).toThrow();
  });
});
```

Append to `test/migrate/legacy-session-migrator.test.ts`:
```ts
it('maps plan_review.drive_to_completion (string "true"), intent, pr and reviewed_sha into v2 fields', () => {
  const s = migrateLegacySession({
    id: 'inv-app-APP-1-20260901',
    mode: 'investigation',
    project: 'git@github.com:acme/app.git',
    created: '2026-09-01T10:00:00Z',
    stage_status: 'findings',
    intent: 'development',
    plan_review: { drive_to_completion: 'true' },
  });
  expect(s.schemaVersion).toBe(2);
  if (s.mode !== 'investigation') throw new Error('mode changed');
  expect(s.intent).toBe('development');
  expect(s.driveToCompletion).toBe(true);

  const r = migrateLegacySession({
    id: 'pr-app-12-20260901',
    mode: 'review',
    project: 'git@github.com:acme/app.git',
    created: '2026-09-01T10:00:00Z',
    stage_status: 'queued',
    pr: { number: 12, url: 'https://github.com/acme/app/pull/12', repo: 'acme/app' },
    reviewed_sha: 'deadbeef',
  });
  expect(r.pr).toEqual({
    repo: 'acme/app', number: 12, url: 'https://github.com/acme/app/pull/12',
    headSha: null, reviewedSha: 'deadbeef', title: null, author: null,
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/schema test/migrate`
Expected: FAIL — `migrateV1ToV2` not exported; `canTransition('review','reviewing','failed')` is false; migrator output lacks `intent`.

- [ ] **Step 3: Implement**

`src/schema/stage.ts`:
```ts
import { z } from 'zod';

export const STAGE_NAMES = ['findings', 'plan', 'develop', 'review', 'rereview'] as const;
export const StageNameSchema = z.enum(STAGE_NAMES);
export type StageName = z.infer<typeof StageNameSchema>;

export const RUN_OUTCOMES = ['running', 'succeeded', 'failed', 'stopped'] as const;
export const RunOutcomeSchema = z.enum(RUN_OUTCOMES);
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

export const LastRunSchema = z.object({
  stage: StageNameSchema,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  outcome: RunOutcomeSchema,
  error: z.string().nullable(),
});
export type LastRun = z.infer<typeof LastRunSchema>;

export const AgentSchema = z.object({
  runner: z.enum(['claude-code', 'codex']),
  resumeId: z.string().min(1).nullable(),
});
export type AgentInfo = z.infer<typeof AgentSchema>;

export const PrSchema = z.object({
  repo: z.string().min(1), // "owner/name"
  number: z.number().int().positive(),
  url: z.string().min(1),
  headSha: z.string().min(1).nullable(),
  reviewedSha: z.string().min(1).nullable(),
  title: z.string().nullable(),
  author: z.string().nullable(),
});
export type PrInfo = z.infer<typeof PrSchema>;
```

`src/schema/pipeline.ts` — change only these parts:
```ts
export const REVIEW_PHASES = [
  'queued',
  'reviewing',
  'ready',
  'approved',
  'changes_requested',
  'dismissed',
  'failed',
] as const;

const REVIEW_TRANSITIONS: Record<ReviewPhase, readonly ReviewPhase[]> = {
  queued: ['reviewing'],
  reviewing: ['ready', 'failed', 'dismissed'],
  ready: ['approved', 'changes_requested', 'reviewing', 'dismissed'],
  changes_requested: ['reviewing', 'dismissed'],
  failed: ['reviewing', 'dismissed'],
  approved: [],
  dismissed: [],
};
```

`src/schema/session.ts` (full replacement):
```ts
import { z } from 'zod';
import { SessionModeSchema, type SessionMode } from './session-mode';
import { INVESTIGATION_PHASES, DEVELOPMENT_PHASES, REVIEW_PHASES } from './pipeline';
import { AgentSchema, LastRunSchema, PrSchema } from './stage';

export { SessionModeSchema };
export type { SessionMode };

const WorkspaceSchema = z.object({
  repoUrl: z.string().min(1),
  worktreePath: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
});

const LineageSchema = z.object({
  pipelineId: z.string().min(1),
  parentSessionId: z.string().min(1).nullable(),
  ticket: z.string().min(1).nullable(),
});

// ---- v1 (Phase 0) — kept so old documents on disk still parse ----
const V1Base = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  workspace: WorkspaceSchema,
  lineage: LineageSchema,
});
export const SessionV1Schema = z.discriminatedUnion('mode', [
  V1Base.extend({ mode: z.literal('investigation'), stageStatus: z.enum(INVESTIGATION_PHASES) }),
  V1Base.extend({ mode: z.literal('development'), stageStatus: z.enum(DEVELOPMENT_PHASES) }),
  V1Base.extend({ mode: z.literal('review'), stageStatus: z.enum(REVIEW_PHASES) }),
]);
export type SessionV1 = z.infer<typeof SessionV1Schema>;

// ---- v2 (Phase 3a) ----
const V2Base = z.object({
  schemaVersion: z.literal(2),
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  workspace: WorkspaceSchema,
  lineage: LineageSchema,
  agent: AgentSchema.nullable(),
  lastRun: LastRunSchema.nullable(),
  pr: PrSchema.nullable(),
});

export const IntentSchema = z.enum(['investigate_only', 'development']);
export type Intent = z.infer<typeof IntentSchema>;

export const SessionSchema = z.discriminatedUnion('mode', [
  V2Base.extend({
    mode: z.literal('investigation'),
    stageStatus: z.enum(INVESTIGATION_PHASES),
    intent: IntentSchema,
    driveToCompletion: z.boolean(),
  }),
  V2Base.extend({
    mode: z.literal('development'),
    stageStatus: z.enum(DEVELOPMENT_PHASES),
  }),
  V2Base.extend({
    mode: z.literal('review'),
    stageStatus: z.enum(REVIEW_PHASES),
    reviewVersion: z.number().int().nonnegative(),
  }),
]);
export type Session = z.infer<typeof SessionSchema>;
export type InvestigationSession = Extract<Session, { mode: 'investigation' }>;
export type DevelopmentSession = Extract<Session, { mode: 'development' }>;
export type ReviewSession = Extract<Session, { mode: 'review' }>;

export function migrateV1ToV2(v1: SessionV1): Session {
  const base = {
    ...v1,
    schemaVersion: 2 as const,
    agent: null,
    lastRun: null,
    pr: null,
  };
  switch (v1.mode) {
    case 'investigation':
      return SessionSchema.parse({ ...base, intent: 'investigate_only', driveToCompletion: false });
    case 'development':
      return SessionSchema.parse(base);
    case 'review':
      return SessionSchema.parse({ ...base, reviewVersion: 0 });
  }
}

export function parseSession(data: unknown): Session {
  const version =
    data && typeof data === 'object' ? (data as { schemaVersion?: unknown }).schemaVersion : undefined;
  if (version === 1) {
    return migrateV1ToV2(SessionV1Schema.parse(data));
  }
  return SessionSchema.parse(data);
}
```

`src/migrate/legacy-session-migrator.ts` — extend `LegacySessionSchema` and the candidate:
```ts
const LegacySessionSchema = z.object({
  id: z.string().min(1),
  mode: SessionModeSchema,
  project: z.string().min(1),
  created: z.string().min(1),
  stage_status: z.string().min(1).optional(),
  intent: z.enum(['investigate_only', 'development']).optional(),
  plan_review: z
    .object({ drive_to_completion: z.union([z.boolean(), z.string()]).optional() })
    .optional(),
  pr: z
    .object({
      number: z.union([z.number(), z.string()]),
      url: z.string().min(1),
      repo: z.string().min(1).optional(),
    })
    .optional(),
  reviewed_sha: z.string().min(1).optional(),
  lineage: z
    .object({
      pipeline_id: z.string().min(1).optional(),
      parent_session_id: z.string().min(1).nullable().optional(),
      ticket: z.string().min(1).nullable().optional(),
    })
    .optional(),
});

function repoSlugFromUrl(url: string): string {
  // git@github.com:owner/name.git | https://github.com/owner/name(.git)
  const m = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1] : url;
}
```
and build the candidate as v2:
```ts
  const drive = legacy.plan_review?.drive_to_completion;
  const driveToCompletion = drive === true || drive === 'true';
  const pr = legacy.pr
    ? {
        repo: legacy.pr.repo ?? repoSlugFromUrl(legacy.project),
        number: Number(legacy.pr.number),
        url: legacy.pr.url,
        headSha: null,
        reviewedSha: legacy.reviewed_sha ?? null,
        title: null,
        author: null,
      }
    : null;

  const base = {
    schemaVersion: 2 as const,
    id: legacy.id,
    mode: legacy.mode,
    createdAt: createdAtDate.toISOString(),
    workspace: { repoUrl: legacy.project },
    lineage: {
      pipelineId: legacy.lineage?.pipeline_id ?? legacy.id,
      parentSessionId: legacy.lineage?.parent_session_id ?? null,
      ticket: legacy.lineage?.ticket ?? null,
    },
    stageStatus: legacy.stage_status ?? defaultStageStatus(legacy.mode),
    agent: null,
    lastRun: null,
    pr,
  };
  const candidate =
    legacy.mode === 'investigation'
      ? { ...base, intent: legacy.intent ?? 'investigate_only', driveToCompletion }
      : legacy.mode === 'review'
        ? { ...base, reviewVersion: 0 }
        : base;
  return parseSession(candidate);
```
Fix any existing test that asserted `schemaVersion: 1` on the migrator's output to assert `2`.

- [ ] **Step 4: Run the whole suite**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all green. Existing fixtures with `schemaVersion: 1` still parse (they migrate). If a test compares a saved-then-loaded session with `toEqual` against a v1 literal, update the literal to v2 via `migrateV1ToV2(...)` rather than weakening the assertion.

- [ ] **Step 5: Commit**

```bash
git add src/schema test/schema src/migrate test/migrate
git commit -m "feat(cgremlin-core): schema v2 (agent/lastRun/pr, intent, driveToCompletion, reviewVersion), review failed phase, v1->v2 migration"
```

---

### Task 2: `SessionContext` extensions and `ClaudeCodeRunner --add-dir` / seeded resume

**Files:**
- Modify: `src/agent/agent-runner.ts`
- Modify: `src/agent/claude-code-runner.ts`
- Modify: `test/support/fake-agent-runner.ts`
- Test: `test/agent/claude-code-runner.test.ts`, `test/agent/fake-agent-runner.test.ts`

**Interfaces:**
- Produces:
  - `SessionContext` gains `readonly additionalDirs?: readonly string[]` and `readonly resumeId?: string`.
  - `AgentRunner` gains optional `getResumeId?(handle: AgentHandle): string | undefined`.
  - `ClaudeCodeRunner.start` seeds `claudeSessionId` from `ctx.resumeId`; `sendPrompt` appends `--add-dir <dir>` once per entry of `ctx.additionalDirs` (after `--permission-mode`, before `--model`); `getResumeId` returns the captured id.
  - `FakeAgentRunner` gains `getResumeId(handle)` and a test-control `setResumeId(handle, id)`.

- [ ] **Step 1: Write the failing tests**

Add to `test/agent/claude-code-runner.test.ts` (pattern copied from the existing exact-argv test that uses `FAKE_CLI_ARGV_LOG`):
```ts
it('passes --add-dir per additional directory and seeds --resume from ctx.resumeId, in a pinned argv order', async () => {
  const argvLogPath = path.join(tmpdir(), `claude-code-runner-argv-adddir-${Date.now()}.json`);
  process.env.FAKE_CLI_ARGV_LOG = argvLogPath;
  try {
    const runner = new ClaudeCodeRunner({ claudeBinary: fixturePath, model: 'opus' });
    const handle = await runner.start({
      sessionId: 's1',
      workingDirectory: tmpdir(),
      additionalDirs: ['/sessions/s1', '/extra'],
      resumeId: 'seed-123',
    });
    await runner.sendPrompt(handle, 'hello');
    const argv = JSON.parse(await readFile(argvLogPath, 'utf8'));
    expect(argv).toEqual([
      '-p', 'hello',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
      '--add-dir', '/sessions/s1',
      '--add-dir', '/extra',
      '--model', 'opus',
      '--resume', 'seed-123',
    ]);
    // the fixture echoes `resumed:<id>` as the new session id
    expect(runner.getResumeId(handle)).toBe('resumed:seed-123');
  } finally {
    delete process.env.FAKE_CLI_ARGV_LOG;
    await rm(argvLogPath, { force: true });
  }
});
```

Add to `test/agent/fake-agent-runner.test.ts`:
```ts
it('exposes and allows seeding a resume id for tests', async () => {
  const runner = new FakeAgentRunner();
  const handle = await runner.start({ sessionId: 's', workingDirectory: '/w', resumeId: 'seed' });
  expect(runner.getResumeId(handle)).toBe('seed');
  runner.setResumeId(handle, 'next');
  expect(runner.getResumeId(handle)).toBe('next');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/agent`
Expected: FAIL — argv lacks `--add-dir`/seeded `--resume`; `getResumeId` is not a function.

- [ ] **Step 3: Implement**

`src/agent/agent-runner.ts`:
```ts
export interface SessionContext {
  readonly sessionId: string;
  readonly workingDirectory: string;
  /** Extra directories the agent may read/write (e.g. the session dir holding BRIEF.md). */
  readonly additionalDirs?: readonly string[];
  /** Adapter-specific conversation id to continue from (Claude: `--resume`). */
  readonly resumeId?: string;
}

export interface AgentRunner {
  start(ctx: SessionContext): Promise<AgentHandle>;
  sendPrompt(handle: AgentHandle, prompt: string): Promise<void>;
  onOutput(handle: AgentHandle, callback: (chunk: AgentOutput) => void): void;
  onExit(handle: AgentHandle, callback: (result: AgentExitResult) => void): void;
  stop(handle: AgentHandle): Promise<void>;
  /** The id a later `start({ resumeId })` should pass to continue this conversation, if the adapter has one. */
  getResumeId?(handle: AgentHandle): string | undefined;
}
```

`src/agent/claude-code-runner.ts`:
- in `start`: `this.handles.set(id, { ctx, outputCallbacks: [], exitCallbacks: [], claudeSessionId: ctx.resumeId });`
- in `sendPrompt`, after the `--permission-mode` pair:
```ts
    for (const dir of state.ctx.additionalDirs ?? []) {
      args.push('--add-dir', dir);
    }
```
- add:
```ts
  getResumeId(handle: AgentHandle): string | undefined {
    return this.getClaudeSessionId(handle);
  }
```

`test/support/fake-agent-runner.ts`: add `resumeId?: string` to `FakeAgentState`, set from `ctx.resumeId` in `start`, and:
```ts
  getResumeId(handle: AgentHandle): string | undefined {
    return this.requireState(handle).resumeId;
  }
  setResumeId(handle: AgentHandle, id: string): void {
    this.requireState(handle).resumeId = id;
  }
```

- [ ] **Step 4: Run the suite**

Run: `pnpm test && pnpm typecheck && pnpm lint` — green.

- [ ] **Step 5: Commit**

```bash
git add src/agent test/agent test/support/fake-agent-runner.ts
git commit -m "feat(cgremlin-core): SessionContext additionalDirs/resumeId, ClaudeCodeRunner --add-dir and seeded resume, getResumeId"
```

---

### Task 3: Permission guards without dead `cgremlin --…` callbacks

**Files:**
- Modify: `src/workspace/permission-guard.ts`
- Test: `test/workspace/permission-guard.test.ts`

**Interfaces:**
- Produces: `DEFAULT_PERMISSIONS.investigation = {}`; `DEFAULT_PERMISSIONS.development = { deny: ['Bash(gh pr review:*)','Bash(gh pr comment:*)','Bash(gh pr merge:*)','Bash(gh pr close:*)'] }`; `review` unchanged. `renderPermissionSettings({})` returns `{"permissions": {}}` (already the behavior).

- [ ] **Step 1: Write the failing tests**
```ts
it('no mode allow-lists legacy cgremlin CLI callbacks (agents never call back into the engine)', () => {
  for (const mode of ['investigation', 'development', 'review'] as const) {
    const rendered = renderPermissionSettings(DEFAULT_PERMISSIONS[mode]);
    expect(rendered).not.toContain('cgremlin --');
  }
});
it('development denies GitHub review/comment/merge/close mutations but leaves push and pr create to the agent', () => {
  const deny = DEFAULT_PERMISSIONS.development.deny ?? [];
  expect(deny).toEqual(expect.arrayContaining([
    'Bash(gh pr review:*)', 'Bash(gh pr comment:*)', 'Bash(gh pr merge:*)', 'Bash(gh pr close:*)',
  ]));
  expect(deny).not.toContain('Bash(git push:*)');
  expect(deny).not.toContain('Bash(gh pr create:*)');
});
```
- [ ] **Step 2: RED** — `pnpm vitest run test/workspace/permission-guard.test.ts` fails on the `cgremlin --` assertion.
- [ ] **Step 3: Implement** — replace the `investigation` and `development` entries as specified above. Update any existing test asserting the old allow-lists.
- [ ] **Step 4: GREEN** — `pnpm test && pnpm typecheck && pnpm lint`.
- [ ] **Step 5: Commit** — `git commit -m "feat(cgremlin-core): drop legacy cgremlin callback allow-lists from permission guards; deny gh PR mutations in development"`

---

### Task 4: Prompt and brief templates

**Files:**
- Create: `src/pipeline/prompts.ts`
- Test: `test/pipeline/prompts.test.ts`

**Interfaces:**
- Produces:
```ts
export interface BriefCommon { sessionDir: string; ticket: string | null }
export interface FindingsBriefParams extends BriefCommon { intent: 'investigate_only' | 'development' }
export interface PlanBriefParams extends BriefCommon { driveToCompletion: boolean }
export interface DevelopBriefParams extends BriefCommon { hasPlan: boolean }
export interface ReviewPromptParams { sessionDir: string; reviewSkillCommand?: string; includeLiveUiCheck?: boolean }
export interface RereviewPromptParams { sessionDir: string; commitCount: number; reviewSkillCommand?: string }
export function renderFindingsBrief(p: FindingsBriefParams): string
export function renderPlanBrief(p: PlanBriefParams): string
export function renderDevelopBrief(p: DevelopBriefParams): string
export function renderReviewPrompt(p: ReviewPromptParams): string
export function renderRereviewPrompt(p: RereviewPromptParams): string
export const STAGE_ENTRY_PROMPT: (sessionDir: string) => string  // "Read <sessionDir>/BRIEF.md and follow it. BEGIN NOW."
```
  Defaults: `reviewSkillCommand = '/APFM:apfm-review'`, `includeLiveUiCheck = true`.

- [ ] **Step 1: Write the failing tests**
```ts
import { describe, expect, it } from 'vitest';
import {
  renderDevelopBrief, renderFindingsBrief, renderPlanBrief,
  renderRereviewPrompt, renderReviewPrompt, STAGE_ENTRY_PROMPT,
} from '../../src/pipeline/prompts';

const sessionDir = '/s/inv-1';

describe('prompt templates', () => {
  it('never instruct the agent to call back into cgremlin', () => {
    const all = [
      renderFindingsBrief({ sessionDir, ticket: 'APP-1', intent: 'development' }),
      renderPlanBrief({ sessionDir, ticket: 'APP-1', driveToCompletion: true }),
      renderDevelopBrief({ sessionDir, ticket: 'APP-1', hasPlan: true }),
      renderReviewPrompt({ sessionDir }),
      renderRereviewPrompt({ sessionDir, commitCount: 2 }),
    ];
    for (const text of all) expect(text).not.toMatch(/cgremlin --/);
  });

  it('findings brief names FINDINGS.md in the session dir, the ticket, and the AGENT_NOTE/AGENT_STATE files', () => {
    const t = renderFindingsBrief({ sessionDir, ticket: 'APP-1', intent: 'investigate_only' });
    expect(t).toContain(`${sessionDir}/FINDINGS.md`);
    expect(t).toContain('APP-1');
    expect(t).toContain(`${sessionDir}/AGENT_NOTE`);
    expect(t).toContain(`${sessionDir}/AGENT_STATE`);
    expect(t).toContain('Do NOT change code');
  });

  it('plan brief requires the exact "## Review Status" block with PM and Principal Engineer lines and the 3-round cap', () => {
    const t = renderPlanBrief({ sessionDir, ticket: 'APP-1', driveToCompletion: false });
    expect(t).toContain('## Review Status');
    expect(t).toContain('- PM: ✅ Approved');
    expect(t).toContain('- Principal Engineer: ✅ Approved');
    expect(t).toContain('## Unresolved Review Disagreement');
    expect(t).toContain('3 total rounds');
    expect(t).toContain(`${sessionDir}/PLAN.md`);
  });

  it('review prompt reproduces the legacy contract with the skill command and REVIEW.md path', () => {
    const t = renderReviewPrompt({ sessionDir });
    expect(t).toContain('Run /APFM:apfm-review and write the findings to REVIEW.md');
    expect(t).toContain("run the '## LIVE UI CHECK' section");
    expect(t).toContain('Do NOT post to GitHub');
    expect(t).toContain(`Write the output to ${sessionDir}/REVIEW.md`);
  });

  it('review prompt can swap the skill command and omit the live UI check', () => {
    const t = renderReviewPrompt({ sessionDir, reviewSkillCommand: '/noop-review', includeLiveUiCheck: false });
    expect(t).toContain('Run /noop-review');
    expect(t).not.toContain('LIVE UI CHECK');
  });

  it('re-review prompt carries the commit count and the rereview_summary contract', () => {
    const t = renderRereviewPrompt({ sessionDir, commitCount: 3 });
    expect(t).toContain('PR updated with 3 new commit(s)');
    expect(t).toContain(`${sessionDir}/rereview_summary`);
    expect(t).toContain("'✅ N/N resolved'");
    expect(t).toContain('✅ resolved / ⚠️ partial (keep open) / ❌ still open / 🔁 regressed');
  });

  it('stage entry prompt points at BRIEF.md', () => {
    expect(STAGE_ENTRY_PROMPT(sessionDir)).toBe(`Read ${sessionDir}/BRIEF.md and follow it exactly. BEGIN NOW.`);
  });
});
```

- [ ] **Step 2: RED** — `pnpm vitest run test/pipeline/prompts.test.ts` fails: module not found.

- [ ] **Step 3: Implement** `src/pipeline/prompts.ts`. The bodies are the legacy texts (bin/cgremlin:14169–14268 investigate, :14330–14420 develop, :14557 review, :14727 re-review) with three edits: every ``cgremlin --agent-note X "msg"`` becomes "write `<sessionDir>/AGENT_NOTE` with the single line `msg`", every ``cgremlin --agent-state X s`` becomes "write `<sessionDir>/AGENT_STATE` containing `s`", every ``cgremlin --plan-start/--plan-ready/--develop/--approve-plan`` line is removed (the engine infers those from files), and the `cgremlin --run-local/--stop-local` steps are removed (Phase 5). The repo is the current working directory, not `./repo/`.

```ts
const DEFAULT_REVIEW_SKILL = '/APFM:apfm-review';

export const STAGE_ENTRY_PROMPT = (sessionDir: string): string =>
  `Read ${sessionDir}/BRIEF.md and follow it exactly. BEGIN NOW.`;

function notes(sessionDir: string): string {
  return `## Status files (the engine reads these; you never call any CLI)
- Progress note: overwrite \`${sessionDir}/AGENT_NOTE\` with ONE line at each milestone (e.g. "tracing checkout path", "root cause found").
- State: overwrite \`${sessionDir}/AGENT_STATE\` with exactly one of \`working\`, \`ready\`, \`needs-input\`, \`blocked\` whenever it changes.`;
}

export function renderFindingsBrief(p: FindingsBriefParams): string {
  const key = p.ticket ?? '(no ticket)';
  const ticketLine = p.ticket
    ? `The ticket is ${p.ticket}. Fetch it now via the Atlassian MCP (getJiraIssue) to read the summary, description, and acceptance criteria.`
    : '';
  const after =
    p.intent === 'development'
      ? `This investigation is development-bound. When FINDINGS.md is complete, write \`${p.sessionDir}/AGENT_NOTE\` = "findings complete — ready for planning" and \`${p.sessionDir}/AGENT_STATE\` = \`ready\`, then STOP. The engine will start the planning turn.`
      : `When FINDINGS.md is complete, write \`${p.sessionDir}/AGENT_STATE\` = \`ready\` and \`${p.sessionDir}/AGENT_NOTE\` = "FINDINGS.md ready — review it", present a short summary, and STOP. This investigation was NOT started as development-bound — do not draft a plan.`;
  return `# INVESTIGATION — ${key}

You are running in an isolated git worktree of the repository (the current working directory). Work autonomously. Your first deliverable is a complete, self-contained \`${p.sessionDir}/FINDINGS.md\` — no code changes.

## Source of truth: the Jira ticket
${ticketLine} If the ticket is unavailable or absent, use whatever task description you were given. The ticket defines scope — investigate ONLY what it asks about.

${notes(p.sessionDir)}

## What to do (autonomously — do not ask for routine steps)
1. Understand the request from the ticket. As your first action write \`${p.sessionDir}/AGENT_NOTE\` = "${key}: <one-line goal>".
2. Explore the repository: trace the relevant code paths, reproduce/understand the issue, find the ROOT CAUSE.
3. Write \`${p.sessionDir}/FINDINGS.md\` as a COMPLETE HANDOFF a fresh developer could execute from alone:
   - **What's happening** (the observed problem/behavior)
   - **Root cause** (the specific code and why)
   - **Affected files/paths**
   - **Risks / splash zone** (what a fix could plausibly affect)
   - **Direction / plan** to fix the ticket (concrete steps, scoped to the ticket)
4. Do NOT change code in this step. Investigation produces understanding only.

## Scope discipline
Cover ONLY what the ticket asks. If you find necessary out-of-scope work, note it under a "Tech debt (proposed)" section in FINDINGS.md — do not act on it.

## After FINDINGS.md is complete
${after}
`;
}

export function renderPlanBrief(p: PlanBriefParams): string {
  const key = p.ticket ?? '(no ticket)';
  const tail = p.driveToCompletion
    ? `## Proceeding automatically (drive-to-completion was requested)
Once both reviewers approve and the "## Review Status" block is written, STOP. The engine promotes this plan into development without waiting for a human.`
    : `## Waiting for human approval
Once both reviewers approve and the "## Review Status" block is written, write \`${p.sessionDir}/AGENT_STATE\` = \`ready\` and STOP. A human approves the plan through the engine; do not proceed to implementation.`;
  return `# PLAN — ${key}

You are continuing the investigation of ${key} in the same worktree. \`${p.sessionDir}/FINDINGS.md\` is complete. Your deliverable is \`${p.sessionDir}/PLAN.md\`, reviewed by two subagents.

${notes(p.sessionDir)}

## Drafting the plan (PLAN.md)
Write \`${p.sessionDir}/PLAN.md\`, derived from FINDINGS.md's root cause and direction. It must be bulletproof enough that a fresh developer could implement it without asking you anything. Include:
- **What will be modified** — exact files/functions, not vague areas.
- **How it will work** — the actual mechanism/approach, not just the goal.
- **How it will be tested** — concrete test cases, not "add tests."
- **Scope boundary** — what this plan explicitly does NOT do, to prevent scope creep later.

## Reviewing the plan (PM + Principal Engineer)
Once a PLAN.md draft exists, write \`${p.sessionDir}/AGENT_NOTE\` = "plan drafted — under review", then dispatch TWO subagents in PARALLEL (Task tool) — do NOT do their work inline:

**PM subagent:** reads PLAN.md and FINDINGS.md, checks ONLY: does this plan solve exactly the ticket's stated problem, and nothing more? Flag any scope creep beyond the ticket. Return a verdict: APPROVED, or CHANGES_REQUESTED with specific, actionable reasons.

**Principal Engineer subagent:** reads PLAN.md, FINDINGS.md, and the actual code in the repository, checks: are all the pieces internally consistent — is every modified file/function named correctly, does the described mechanism actually work given the real code, is the test plan concrete and sufficient? Return a verdict: APPROVED, or CHANGES_REQUESTED with specific, actionable reasons.

If either returns CHANGES_REQUESTED: revise PLAN.md based on their reasoning, then re-dispatch BOTH subagents again (a partial re-review is not enough — a revision can affect either lens). Repeat up to 3 total rounds. If both have not approved after 3 rounds, STOP: write a "## Unresolved Review Disagreement" section at the top of PLAN.md quoting each unresolved objection verbatim, write \`${p.sessionDir}/AGENT_STATE\` = \`needs-input\` and \`${p.sessionDir}/AGENT_NOTE\` = "plan review stuck — needs your input", and stop — do not keep iterating past the cap.

Once both approve, write a "## Review Status" section at the TOP of PLAN.md, exactly in this shape (the engine parses it):
\`\`\`
## Review Status
- PM: ✅ Approved — <one-line reasoning>
- Principal Engineer: ✅ Approved — <one-line reasoning>
\`\`\`

${tail}
`;
}

export function renderDevelopBrief(p: DevelopBriefParams): string {
  const key = p.ticket ?? '(no ticket)';
  const planStep = p.hasPlan
    ? `1. **Read \`${p.sessionDir}/PLAN.md\` (your approved plan), then \`${p.sessionDir}/FINDINGS.md\` (and \`${p.sessionDir}/REVIEW.md\` if present) + the ticket.** PLAN.md was already reviewed and approved (PM + Principal Engineer) — implement from it. Copy/adapt PLAN.md into \`${p.sessionDir}/DEVELOPMENT.md\` as your starting point; adapt only if something in PLAN.md is factually wrong against the real code — in that case note the discrepancy in DEVELOPMENT.md, do NOT silently deviate.
2. **No plan re-gate — proceed to implementation.** Promotion into development was explicitly authorized. Do NOT pause for plan approval.`
    : `1. **Read \`${p.sessionDir}/FINDINGS.md\` (and \`${p.sessionDir}/REVIEW.md\` if present) + the ticket.** Refine into a concrete implementation plan; capture it in \`${p.sessionDir}/DEVELOPMENT.md\`.
2. **PLAN GATE — pause.** Write \`${p.sessionDir}/AGENT_STATE\` = \`needs-input\` and STOP so a human can read DEVELOPMENT.md. Do NOT implement until a new turn tells you to proceed.`;
  return `# DEVELOP — ${key}

You are running in an isolated git worktree on the session branch. Keep a running plan/progress log in \`${p.sessionDir}/DEVELOPMENT.md\`.

${notes(p.sessionDir)}

## What to do
${planStep}
3. **Implement with TDD.** For each unit: write the failing test, run it (confirm it fails), write minimal code, run to green, commit. Stay strictly in ticket scope.
4. **Open a draft PR** on the pushed branch: \`git push -u origin HEAD\` then \`gh pr create --draft\`, body summarizing the change and linking ${key}. Record the PR URL as the first line of \`${p.sessionDir}/PR_URL\`.
5. **Verify.** Run the project's focused tests for the change (prove the ticket's issue is fixed plus a smoke pass of the feature's likely splash zone — NOT the full suite unless it is fast).
6. **Finish.** When tested, write \`${p.sessionDir}/AGENT_STATE\` = \`ready\` and \`${p.sessionDir}/AGENT_NOTE\` = "tested — draft PR open", and STOP. Marking the PR ready for review is a human decision.

## Rules
- Never post reviews/comments or merge/close PRs from this session (the guard denies them). \`git push\`, \`gh pr create --draft\`, \`gh pr view\` are fine.
- If you hit something you cannot pass (environment broken), write \`${p.sessionDir}/AGENT_STATE\` = \`blocked\` and explain in AGENT_NOTE.
`;
}

export function renderReviewPrompt(p: ReviewPromptParams): string {
  const skill = p.reviewSkillCommand ?? DEFAULT_REVIEW_SKILL;
  const ui =
    (p.includeLiveUiCheck ?? true)
      ? ` Then ALWAYS run the '## LIVE UI CHECK' section in CLAUDE.md (PM + Designer subagents) and merge its 📋/🎨 findings into REVIEW.md — this is required even when ${skill} handled the code review.`
      : '';
  return `Run ${skill} and write the findings to REVIEW.md following CLAUDE.md.${ui} Proceed autonomously; do NOT ask for confirmation or a verdict. Read the PR with git (the branch is checked out) or gh pr view/diff as needed. If Jira/Atlassian MCP is unavailable, skip Jira context and proceed with the diff alone. Do NOT post to GitHub. Write the output to ${p.sessionDir}/REVIEW.md.`;
}

export function renderRereviewPrompt(p: RereviewPromptParams): string {
  const skill = p.reviewSkillCommand ?? DEFAULT_REVIEW_SKILL;
  return `STEP 1: Check if ${skill} skill is available. If yes, run it for re-review and follow its output — skip everything else. STEP 2 (only if skill unavailable): RE-REVIEW MODE — PR updated with ${p.commitCount} new commit(s). Read ${p.sessionDir}/RE-REVIEW.md and follow it. Update ${p.sessionDir}/REVIEW.md in-place. FIRST verify each prior finding was properly addressed: re-check whether the problem it describes still happens in the new code and classify ✅ resolved / ⚠️ partial (keep open) / ❌ still open / 🔁 regressed, with evidence — 🔇 dismissed stay untouched. THEN add NEW findings only if they pass the evidence bar in CLAUDE.md, written in the file's plain format (What's wrong / Why it matters / Suggested fix), and re-check the PR still satisfies its Jira ticket. Severity is 🔴 Critical / 🟠 High / 🟡 Perf / 🔧 Maintainability. Scope: ONLY files in the PR diff. Add a new row to Review History. Self-check: verify every finding references a changed file. As the very last action, write a single line to the file ${p.sessionDir}/rereview_summary. Format: '✅ N/N resolved' if all prior findings are resolved, or '⚠️ K/N resolved, M new' otherwise. Write only that line — no other content.`;
}
```
Also export the params interfaces listed under Interfaces.

- [ ] **Step 4: GREEN** — `pnpm test && pnpm typecheck && pnpm lint`.
- [ ] **Step 5: Commit** — `git commit -m "feat(cgremlin-core): pipeline prompt/brief templates reproducing legacy contracts without CLI callbacks"`

---

### Task 5: Artifact evaluators

**Files:**
- Create: `src/pipeline/artifacts.ts`
- Test: `test/pipeline/artifacts.test.ts`

**Interfaces:**
- Consumes: `SessionFileSystem`, `AgentExitResult`.
- Produces:
```ts
export type PlanReviewStatus = 'approved' | 'unresolved' | 'missing';
export interface RereviewSummary { resolved: number; total: number; newFindings: number }
export async function evaluateFindings(fs, sessionDir): Promise<{ hasFindings: boolean }>
export async function evaluatePlan(fs, sessionDir): Promise<{ hasPlan: boolean; reviewStatus: PlanReviewStatus }>
export function parsePlanReviewStatus(planText: string): PlanReviewStatus
export async function evaluateReview(exit: AgentExitResult, fs, sessionDir): Promise<'ready' | 'failed'>
export function parseRereviewSummary(line: string): RereviewSummary | null
export async function evaluateRereview(exit, fs, sessionDir): Promise<{ outcome: 'ready' | 'failed'; summary: RereviewSummary | null }>
export async function nextReviewVersion(fs, sessionDir): Promise<number>
export async function readNonEmpty(fs, path): Promise<string | null>  // helper: null if missing or whitespace-only
```

- [ ] **Step 1: Write the failing tests**
```ts
import { describe, expect, it } from 'vitest';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import {
  evaluateFindings, evaluatePlan, evaluateReview, evaluateRereview,
  nextReviewVersion, parsePlanReviewStatus, parseRereviewSummary,
} from '../../src/pipeline/artifacts';

const dir = '/sessions/s1';
const ok = { code: 0, signal: null };
const bad = { code: 1, signal: null };

async function fsWith(files: Record<string, string>): Promise<InMemoryFileSystem> {
  const fs = new InMemoryFileSystem();
  await fs.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) await fs.writeFile(`${dir}/${name}`, content);
  return fs;
}

describe('evaluateFindings', () => {
  it('is false when FINDINGS.md is missing or whitespace-only, true when it has content', async () => {
    expect(await evaluateFindings(await fsWith({}), dir)).toEqual({ hasFindings: false });
    expect(await evaluateFindings(await fsWith({ 'FINDINGS.md': '  \n' }), dir)).toEqual({ hasFindings: false });
    expect(await evaluateFindings(await fsWith({ 'FINDINGS.md': '# Findings\nroot cause' }), dir)).toEqual({ hasFindings: true });
  });
});

describe('parsePlanReviewStatus', () => {
  const approved = `## Review Status
- PM: ✅ Approved — solves the ticket
- Principal Engineer: ✅ Approved — mechanism checks out

# Plan
...`;
  it('is approved only when both ✅ lines are present under ## Review Status', () => {
    expect(parsePlanReviewStatus(approved)).toBe('approved');
    expect(parsePlanReviewStatus(approved.replace('- Principal Engineer: ✅', '- Principal Engineer: ❌'))).toBe('missing');
    expect(parsePlanReviewStatus(approved.replace('## Review Status\n', ''))).toBe('missing');
  });
  it('is unresolved when the disagreement section exists, even if a stale approved block is also present', () => {
    expect(parsePlanReviewStatus(`## Unresolved Review Disagreement\n- PM: ...\n${approved}`)).toBe('unresolved');
  });
});

describe('evaluatePlan', () => {
  it('reports hasPlan=false/missing when PLAN.md is absent', async () => {
    expect(await evaluatePlan(await fsWith({}), dir)).toEqual({ hasPlan: false, reviewStatus: 'missing' });
  });
  it('reports approved for an approved PLAN.md', async () => {
    const fs = await fsWith({ 'PLAN.md': '## Review Status\n- PM: ✅ Approved — x\n- Principal Engineer: ✅ Approved — y\n' });
    expect(await evaluatePlan(fs, dir)).toEqual({ hasPlan: true, reviewStatus: 'approved' });
  });
});

describe('evaluateReview (legacy rule: rc == 0 && REVIEW.md non-empty)', () => {
  it('ready when exit 0 and REVIEW.md has content', async () => {
    expect(await evaluateReview(ok, await fsWith({ 'REVIEW.md': '# PR Review' }), dir)).toBe('ready');
  });
  it('failed when exit is non-zero even if REVIEW.md exists', async () => {
    expect(await evaluateReview(bad, await fsWith({ 'REVIEW.md': '# PR Review' }), dir)).toBe('failed');
  });
  it('failed when killed by signal', async () => {
    expect(await evaluateReview({ code: null, signal: 'SIGTERM' }, await fsWith({ 'REVIEW.md': 'x' }), dir)).toBe('failed');
  });
  it('failed when exit 0 but REVIEW.md missing or empty', async () => {
    expect(await evaluateReview(ok, await fsWith({}), dir)).toBe('failed');
    expect(await evaluateReview(ok, await fsWith({ 'REVIEW.md': '\n' }), dir)).toBe('failed');
  });
});

describe('parseRereviewSummary', () => {
  it('parses both legacy shapes', () => {
    expect(parseRereviewSummary('✅ 4/4 resolved')).toEqual({ resolved: 4, total: 4, newFindings: 0 });
    expect(parseRereviewSummary('⚠️ 2/5 resolved, 1 new\n')).toEqual({ resolved: 2, total: 5, newFindings: 1 });
    expect(parseRereviewSummary('garbage')).toBeNull();
  });
});

describe('evaluateRereview', () => {
  it('returns ready plus the parsed summary; failed with null summary on bad exit', async () => {
    const fs = await fsWith({ 'REVIEW.md': '# r', rereview_summary: '⚠️ 1/3 resolved, 2 new' });
    expect(await evaluateRereview(ok, fs, dir)).toEqual({ outcome: 'ready', summary: { resolved: 1, total: 3, newFindings: 2 } });
    expect(await evaluateRereview(bad, fs, dir)).toEqual({ outcome: 'failed', summary: null });
  });
});

describe('nextReviewVersion (legacy loop: first N with no REVIEW-vN.md)', () => {
  it('is 1 with no archives, and skips existing numbers', async () => {
    expect(await nextReviewVersion(await fsWith({}), dir)).toBe(1);
    expect(await nextReviewVersion(await fsWith({ 'REVIEW-v1.md': 'a', 'REVIEW-v2.md': 'b' }), dir)).toBe(3);
  });
});
```

- [ ] **Step 2: RED** — module not found.

- [ ] **Step 3: Implement** `src/pipeline/artifacts.ts`:
```ts
import type { SessionFileSystem } from '../fs/session-file-system';
import type { AgentExitResult } from '../agent/agent-runner';

export type PlanReviewStatus = 'approved' | 'unresolved' | 'missing';
export interface RereviewSummary { resolved: number; total: number; newFindings: number }

export async function readNonEmpty(fs: SessionFileSystem, path: string): Promise<string | null> {
  if (!(await fs.exists(path))) return null;
  const text = await fs.readFile(path);
  return text.trim().length > 0 ? text : null;
}

export async function evaluateFindings(fs: SessionFileSystem, sessionDir: string) {
  return { hasFindings: (await readNonEmpty(fs, `${sessionDir}/FINDINGS.md`)) !== null };
}

export function parsePlanReviewStatus(planText: string): PlanReviewStatus {
  if (/^## Unresolved Review Disagreement\s*$/m.test(planText)) return 'unresolved';
  const start = planText.search(/^## Review Status\s*$/m);
  if (start < 0) return 'missing';
  const rest = planText.slice(start).split('\n').slice(1);
  const end = rest.findIndex((l) => /^#{1,2} /.test(l));
  const section = (end < 0 ? rest : rest.slice(0, end)).join('\n');
  const pm = /^- PM: ✅/m.test(section);
  const pe = /^- Principal Engineer: ✅/m.test(section);
  return pm && pe ? 'approved' : 'missing';
}

export async function evaluatePlan(fs: SessionFileSystem, sessionDir: string) {
  const text = await readNonEmpty(fs, `${sessionDir}/PLAN.md`);
  if (text === null) return { hasPlan: false, reviewStatus: 'missing' as PlanReviewStatus };
  return { hasPlan: true, reviewStatus: parsePlanReviewStatus(text) };
}

function exitedCleanly(exit: AgentExitResult): boolean {
  return exit.code === 0 && exit.signal === null;
}

export async function evaluateReview(exit: AgentExitResult, fs: SessionFileSystem, sessionDir: string): Promise<'ready' | 'failed'> {
  if (!exitedCleanly(exit)) return 'failed';
  return (await readNonEmpty(fs, `${sessionDir}/REVIEW.md`)) !== null ? 'ready' : 'failed';
}

export function parseRereviewSummary(line: string): RereviewSummary | null {
  const m = line.trim().match(/^(?:✅|⚠️)\s*(\d+)\/(\d+) resolved(?:,\s*(\d+) new)?$/u);
  if (!m) return null;
  return { resolved: Number(m[1]), total: Number(m[2]), newFindings: m[3] ? Number(m[3]) : 0 };
}

export async function evaluateRereview(exit: AgentExitResult, fs: SessionFileSystem, sessionDir: string) {
  const outcome = await evaluateReview(exit, fs, sessionDir);
  if (outcome === 'failed') return { outcome, summary: null };
  const line = await readNonEmpty(fs, `${sessionDir}/rereview_summary`);
  return { outcome, summary: line === null ? null : parseRereviewSummary(line) };
}

export async function nextReviewVersion(fs: SessionFileSystem, sessionDir: string): Promise<number> {
  let version = 1;
  while (await fs.exists(`${sessionDir}/REVIEW-v${version}.md`)) version += 1;
  return version;
}
```

- [ ] **Step 4: GREEN** — `pnpm test && pnpm typecheck && pnpm lint`.
- [ ] **Step 5: Commit** — `git commit -m "feat(cgremlin-core): artifact evaluators for findings/plan/review/re-review and review version bookkeeping"`

---

### Task 6: Plan gate and engine events

**Files:**
- Create: `src/pipeline/plan-gate.ts`, `src/engine/events.ts`
- Test: `test/pipeline/plan-gate.test.ts`, `test/engine/events.test.ts`

**Interfaces:**
- Produces:
```ts
// plan-gate.ts
export class PlanGateError extends Error { name = 'PlanGateError' }
export function canPromote(session: Session): boolean
export function assertCanPromote(session: Session): asserts session is InvestigationSession

// events.ts
export interface EngineEventMap {
  'session.created': { session: Session };
  'session.transitioned': { session: Session; from: string; to: string };
  'run.started': { session: Session; stage: StageName };
  'run.output': { sessionId: string; stage: StageName; chunk: AgentOutput };
  'run.finished': { session: Session; stage: StageName; outcome: RunOutcome };
}
export class EngineEvents {
  on<K extends keyof EngineEventMap>(type: K, cb: (payload: EngineEventMap[K]) => void): () => void  // returns unsubscribe
  emit<K extends keyof EngineEventMap>(type: K, payload: EngineEventMap[K]): void
}
```

- [ ] **Step 1: Write the failing tests**
```ts
// test/pipeline/plan-gate.test.ts
import { describe, expect, it } from 'vitest';
import { canPromote, assertCanPromote, PlanGateError } from '../../src/pipeline/plan-gate';
import { migrateV1ToV2 } from '../../src/schema/session';

function inv(stageStatus: string, driveToCompletion = false) {
  const s = migrateV1ToV2({
    schemaVersion: 1, id: 'i', mode: 'investigation', createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: 'u' }, lineage: { pipelineId: 'p', parentSessionId: null, ticket: null },
    stageStatus: stageStatus as never,
  });
  return { ...s, driveToCompletion } as typeof s;
}

describe('plan gate (legacy develop_start rule)', () => {
  it('allows approved regardless of drive flag', () => {
    expect(canPromote(inv('approved'))).toBe(true);
    expect(canPromote(inv('approved', true))).toBe(true);
  });
  it('allows plan_ready only with driveToCompletion', () => {
    expect(canPromote(inv('plan_ready', true))).toBe(true);
    expect(canPromote(inv('plan_ready', false))).toBe(false);
  });
  it('rejects every earlier phase even with driveToCompletion', () => {
    for (const p of ['findings', 'planning']) {
      expect(canPromote(inv(p, true))).toBe(false);
    }
  });
  it('rejects non-investigation sessions', () => {
    const dev = { ...inv('approved'), mode: 'development', stageStatus: 'active' } as never;
    expect(canPromote(dev)).toBe(false);
    expect(() => assertCanPromote(dev)).toThrow(PlanGateError);
  });
});
```
```ts
// test/engine/events.test.ts
import { describe, expect, it } from 'vitest';
import { EngineEvents } from '../../src/engine/events';

describe('EngineEvents', () => {
  it('delivers to subscribers of the type only and supports unsubscribe', () => {
    const ev = new EngineEvents();
    const got: string[] = [];
    const off = ev.on('run.output', (p) => got.push(p.chunk.data));
    ev.on('run.started', () => got.push('started'));
    ev.emit('run.output', { sessionId: 's', stage: 'review', chunk: { stream: 'stdout', data: 'a' } });
    off();
    ev.emit('run.output', { sessionId: 's', stage: 'review', chunk: { stream: 'stdout', data: 'b' } });
    expect(got).toEqual(['a']);
  });
  it('a throwing subscriber does not prevent later subscribers from receiving the event', () => {
    const ev = new EngineEvents();
    let second = 0;
    ev.on('run.started', () => { throw new Error('boom'); });
    ev.on('run.started', () => { second += 1; });
    ev.emit('run.started', { session: {} as never, stage: 'review' });
    expect(second).toBe(1);
  });
});
```

- [ ] **Step 2: RED** — modules not found.

- [ ] **Step 3: Implement**
```ts
// src/pipeline/plan-gate.ts
import type { InvestigationSession, Session } from '../schema/session';

export class PlanGateError extends Error {
  constructor(message: string) { super(message); this.name = 'PlanGateError'; }
}

export function canPromote(session: Session): boolean {
  if (session.mode !== 'investigation') return false;
  return (
    session.stageStatus === 'approved' ||
    (session.driveToCompletion && session.stageStatus === 'plan_ready')
  );
}

export function assertCanPromote(session: Session): asserts session is InvestigationSession {
  if (!canPromote(session)) {
    const detail =
      session.mode !== 'investigation'
        ? `session '${session.id}' is a ${session.mode} session`
        : `phase is '${session.stageStatus}', driveToCompletion=${session.driveToCompletion}`;
    throw new PlanGateError(`Cannot promote to development: ${detail} — approve the plan first`);
  }
}
```
```ts
// src/engine/events.ts
import type { Session } from '../schema/session';
import type { StageName, RunOutcome } from '../schema/stage';
import type { AgentOutput } from '../agent/agent-runner';

export interface EngineEventMap {
  'session.created': { session: Session };
  'session.transitioned': { session: Session; from: string; to: string };
  'run.started': { session: Session; stage: StageName };
  'run.output': { sessionId: string; stage: StageName; chunk: AgentOutput };
  'run.finished': { session: Session; stage: StageName; outcome: RunOutcome };
}

type Listener<K extends keyof EngineEventMap> = (payload: EngineEventMap[K]) => void;

export class EngineEvents {
  private readonly listeners = new Map<keyof EngineEventMap, Set<Listener<never>>>();

  on<K extends keyof EngineEventMap>(type: K, cb: Listener<K>): () => void {
    const set = this.listeners.get(type) ?? new Set<Listener<never>>();
    set.add(cb as Listener<never>);
    this.listeners.set(type, set);
    return () => { set.delete(cb as Listener<never>); };
  }

  emit<K extends keyof EngineEventMap>(type: K, payload: EngineEventMap[K]): void {
    for (const cb of [...(this.listeners.get(type) ?? [])]) {
      try {
        (cb as Listener<K>)(payload);
      } catch {
        // A misbehaving subscriber must not break the engine or its other subscribers.
      }
    }
  }
}
```

- [ ] **Step 4: GREEN** — `pnpm test && pnpm typecheck && pnpm lint`.
- [ ] **Step 5: Commit** — `git commit -m "feat(cgremlin-core): plan-approval gate and typed engine event emitter"`


---

### Task 7: `StageRunner` — one agent turn per call, completion keyed off `onExit`

**Files:**
- Create: `src/pipeline/stage-runner.ts`
- Test: `test/pipeline/stage-runner.test.ts`

**Interfaces:**
- Consumes: `AgentRunner`, `SessionStore`, `SessionFileSystem`, `EngineEvents`, `Session`, `StageName`, `LastRun`.
- Produces:
```ts
export class RunInProgressError extends Error { name = 'RunInProgressError' }
export class WorkspaceMissingError extends Error { name = 'WorkspaceMissingError' }
export interface StageRunnerDeps {
  runner: AgentRunner; store: SessionStore; fs: SessionFileSystem; events: EngineEvents;
  sessionsDir: string; runnerKind: 'claude-code' | 'codex'; now?: () => Date;
}
export interface StageRunInput { sessionId: string; stage: StageName; brief: string | null; prompt: string }
export interface StageRunResult { exit: AgentExitResult; outcome: 'succeeded' | 'failed' | 'stopped'; session: Session }
export class StageRunner {
  constructor(deps: StageRunnerDeps)
  run(input: StageRunInput): Promise<StageRunResult>
  stop(sessionId: string): Promise<boolean>   // false if nothing running
  isRunning(sessionId: string): boolean
}
```
  Behavior:
  1. Load session; throw `RunInProgressError` if `isRunning`; throw `WorkspaceMissingError` if `workspace.worktreePath` is unset.
  2. If `brief !== null`, write `<sessionsDir>/<id>/BRIEF.md`. Always (re)write `<sessionDir>/AGENT_STATE` = `working`.
  3. Persist `lastRun = { stage, startedAt: now, finishedAt: null, exitCode: null, signal: null, outcome: 'running', error: null }` and `agent = { runner: runnerKind, resumeId: session.agent?.resumeId ?? null }`; emit `run.started`.
  4. `handle = await runner.start({ sessionId, workingDirectory: worktreePath, additionalDirs: [sessionDir], resumeId: session.agent?.resumeId ?? undefined })`. Register `onOutput` → emit `run.output`. Register `onExit` → resolve an internal promise. **Then** `sendPrompt`. Completion = the `onExit` promise; do not treat `sendPrompt` resolving as completion (`FakeAgentRunner` resolves it immediately; `ClaudeCodeRunner` resolves it after exit — the runner must work with both).
  5. Outcome: `stopped` if `stop()` was called during the run; else `failed` if `exit.code !== 0 || exit.signal !== null`; else `succeeded`. Persist `lastRun` (finishedAt, exitCode, signal, outcome, `error` = `'agent exited with code N'` / `'agent killed by SIGX'` / `'stopped by user'` / `null`) and `agent.resumeId = runner.getResumeId?.(handle) ?? previous`. Emit `run.finished`. Return.
  6. `run` never transitions `stageStatus` — that is the service's job (it knows which artifact rule applies).
  7. If `runner.start`/`sendPrompt` throws, persist `lastRun.outcome = 'failed'` with the error message, clear the running flag, rethrow.

- [ ] **Step 1: Write the failing tests**
```ts
import { describe, expect, it } from 'vitest';
import { FakeAgentRunner } from '../support/fake-agent-runner';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { SessionStore } from '../../src/engine/session-store';
import { EngineEvents } from '../../src/engine/events';
import { RunInProgressError, StageRunner, WorkspaceMissingError } from '../../src/pipeline/stage-runner';
import { migrateV1ToV2 } from '../../src/schema/session';

const sessionsDir = '/sessions';
function inv(overrides: Partial<{ worktreePath: string | undefined; resumeId: string | null }> = {}) {
  const s = migrateV1ToV2({
    schemaVersion: 1, id: 'inv-1', mode: 'investigation', createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: 'u', worktreePath: '/w/inv-1', branch: 'investigate/APP-1' },
    lineage: { pipelineId: 'p', parentSessionId: null, ticket: 'APP-1' },
    stageStatus: 'findings',
  });
  if ('worktreePath' in overrides) s.workspace = { ...s.workspace, worktreePath: overrides.worktreePath };
  if (overrides.resumeId !== undefined) s.agent = { runner: 'claude-code', resumeId: overrides.resumeId };
  return s;
}

async function setup(session = inv()) {
  const fs = new InMemoryFileSystem();
  const store = new SessionStore(fs, sessionsDir);
  await store.save(session);
  const runner = new FakeAgentRunner();
  const events = new EngineEvents();
  const now = () => new Date('2026-09-04T12:00:00.000Z');
  const sr = new StageRunner({ runner, store, fs, events, sessionsDir, runnerKind: 'claude-code', now });
  return { fs, store, runner, events, sr };
}

function lastHandle(runner: FakeAgentRunner) {
  // FakeAgentRunner ids are fake-agent-N; the most recent is the highest N
  return { id: `fake-agent-${(runner as unknown as { nextId: number }).nextId - 1}` };
}

describe('StageRunner.run', () => {
  it('writes BRIEF.md and AGENT_STATE=working, passes the session dir as additionalDirs and the worktree as cwd, and sends the prompt', async () => {
    const { fs, runner, sr } = await setup();
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: '# brief', prompt: 'go' });
    await Promise.resolve(); await Promise.resolve();
    expect(await fs.readFile('/sessions/inv-1/BRIEF.md')).toBe('# brief');
    expect(await fs.readFile('/sessions/inv-1/AGENT_STATE')).toBe('working');
    const h = lastHandle(runner);
    expect(runner.getContext(h)).toEqual({
      sessionId: 'inv-1', workingDirectory: '/w/inv-1', additionalDirs: ['/sessions/inv-1'], resumeId: undefined,
    });
    expect(runner.getPrompts(h)).toEqual(['go']);
    runner.emitExit(h, { code: 0, signal: null });
    const result = await p;
    expect(result.outcome).toBe('succeeded');
  });

  it('records lastRun running → succeeded with timestamps, and persists the runner resume id', async () => {
    const { store, runner, sr, events } = await setup();
    const started: string[] = []; const finished: string[] = [];
    events.on('run.started', (e) => started.push(e.stage));
    events.on('run.finished', (e) => finished.push(e.outcome));
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await Promise.resolve(); await Promise.resolve();
    expect((await store.load('inv-1')).lastRun).toMatchObject({ stage: 'findings', outcome: 'running', finishedAt: null });
    const h = lastHandle(runner);
    runner.setResumeId(h, 'claude-sess-1');
    runner.emitExit(h, { code: 0, signal: null });
    const { session } = await p;
    expect(session.lastRun).toEqual({
      stage: 'findings', startedAt: '2026-09-04T12:00:00.000Z', finishedAt: '2026-09-04T12:00:00.000Z',
      exitCode: 0, signal: null, outcome: 'succeeded', error: null,
    });
    expect(session.agent).toEqual({ runner: 'claude-code', resumeId: 'claude-sess-1' });
    expect(started).toEqual(['findings']); expect(finished).toEqual(['succeeded']);
  });

  it('seeds resumeId from the session so a restarted engine continues the same conversation', async () => {
    const { runner, sr } = await setup(inv({ resumeId: 'prev' }));
    const p = sr.run({ sessionId: 'inv-1', stage: 'plan', brief: null, prompt: 'plan' });
    await Promise.resolve(); await Promise.resolve();
    const h = lastHandle(runner);
    expect(runner.getContext(h).resumeId).toBe('prev');
    runner.emitExit(h, { code: 0, signal: null });
    await p;
  });

  it('marks failed on non-zero exit and on signal, with a message', async () => {
    const { runner, sr } = await setup();
    const p1 = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await Promise.resolve(); await Promise.resolve();
    runner.emitExit(lastHandle(runner), { code: 2, signal: null });
    expect((await p1).session.lastRun).toMatchObject({ outcome: 'failed', exitCode: 2, error: 'agent exited with code 2' });
    const p2 = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await Promise.resolve(); await Promise.resolve();
    runner.emitExit(lastHandle(runner), { code: null, signal: 'SIGKILL' });
    expect((await p2).session.lastRun).toMatchObject({ outcome: 'failed', signal: 'SIGKILL', error: 'agent killed by SIGKILL' });
  });

  it('does not treat sendPrompt resolving as completion — the run stays running until onExit fires', async () => {
    const { store, runner, sr } = await setup();
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    let settled = false; void p.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 20)); // FakeAgentRunner.sendPrompt has resolved long ago by now
    expect(settled).toBe(false);
    expect(sr.isRunning('inv-1')).toBe(true);
    expect((await store.load('inv-1')).lastRun?.outcome).toBe('running');
    runner.emitExit(lastHandle(runner), { code: 0, signal: null });
    await p;
    expect(settled).toBe(true);
  });

  it('stop() kills the runner and the run resolves as stopped once exit arrives', async () => {
    const { runner, sr } = await setup();
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await Promise.resolve(); await Promise.resolve();
    const h = lastHandle(runner);
    expect(await sr.stop('inv-1')).toBe(true);
    expect(runner.isStopped(h)).toBe(true);
    runner.emitExit(h, { code: null, signal: 'SIGTERM' });
    const r = await p;
    expect(r.outcome).toBe('stopped');
    expect(r.session.lastRun).toMatchObject({ outcome: 'stopped', error: 'stopped by user' });
    expect(sr.isRunning('inv-1')).toBe(false);
    expect(await sr.stop('inv-1')).toBe(false);
  });

  it('rejects a second concurrent run for the same session and allows a different session', async () => {
    const { store, runner, sr } = await setup();
    await store.save({ ...inv(), id: 'inv-2', workspace: { repoUrl: 'u', worktreePath: '/w/inv-2' } });
    const p = sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' });
    await Promise.resolve(); await Promise.resolve();
    await expect(sr.run({ sessionId: 'inv-1', stage: 'plan', brief: null, prompt: 'x' })).rejects.toThrow(RunInProgressError);
    const p2 = sr.run({ sessionId: 'inv-2', stage: 'findings', brief: null, prompt: 'go' });
    await Promise.resolve(); await Promise.resolve();
    runner.emitExit({ id: 'fake-agent-1' }, { code: 0, signal: null });
    runner.emitExit({ id: 'fake-agent-2' }, { code: 0, signal: null });
    await Promise.all([p, p2]);
  });

  it('throws WorkspaceMissingError when the session has no worktree', async () => {
    const { sr } = await setup(inv({ worktreePath: undefined }));
    await expect(sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' })).rejects.toThrow(WorkspaceMissingError);
  });

  it('a runner.start failure is recorded as a failed run and rethrown, and clears the running flag', async () => {
    const { store, sr, runner } = await setup();
    runner.start = async () => { throw new Error('spawn ENOENT'); };
    await expect(sr.run({ sessionId: 'inv-1', stage: 'findings', brief: null, prompt: 'go' })).rejects.toThrow('spawn ENOENT');
    expect((await store.load('inv-1')).lastRun).toMatchObject({ outcome: 'failed', error: 'spawn ENOENT' });
    expect(sr.isRunning('inv-1')).toBe(false);
  });
});
```

- [ ] **Step 2: RED** — `pnpm vitest run test/pipeline/stage-runner.test.ts`: module not found.

- [ ] **Step 3: Implement** `src/pipeline/stage-runner.ts`:
```ts
import type { AgentExitResult, AgentHandle, AgentRunner } from '../agent/agent-runner';
import type { SessionFileSystem } from '../fs/session-file-system';
import type { SessionStore } from '../engine/session-store';
import type { EngineEvents } from '../engine/events';
import type { Session } from '../schema/session';
import type { LastRun, StageName } from '../schema/stage';

export class RunInProgressError extends Error {
  constructor(sessionId: string) {
    super(`Session '${sessionId}' already has a stage run in progress`);
    this.name = 'RunInProgressError';
  }
}
export class WorkspaceMissingError extends Error {
  constructor(sessionId: string) {
    super(`Session '${sessionId}' has no worktree; create its workspace before running a stage`);
    this.name = 'WorkspaceMissingError';
  }
}

export interface StageRunnerDeps {
  runner: AgentRunner;
  store: SessionStore;
  fs: SessionFileSystem;
  events: EngineEvents;
  sessionsDir: string;
  runnerKind: 'claude-code' | 'codex';
  now?: () => Date;
}
export interface StageRunInput { sessionId: string; stage: StageName; brief: string | null; prompt: string }
export interface StageRunResult { exit: AgentExitResult; outcome: 'succeeded' | 'failed' | 'stopped'; session: Session }

interface ActiveRun { handle: AgentHandle | null; stopRequested: boolean }

export class StageRunner {
  private readonly active = new Map<string, ActiveRun>();
  private readonly now: () => Date;

  constructor(private readonly deps: StageRunnerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  async stop(sessionId: string): Promise<boolean> {
    const run = this.active.get(sessionId);
    if (!run) return false;
    run.stopRequested = true;
    if (run.handle) await this.deps.runner.stop(run.handle);
    return true;
  }

  async run(input: StageRunInput): Promise<StageRunResult> {
    const { sessionId, stage } = input;
    if (this.active.has(sessionId)) throw new RunInProgressError(sessionId);
    let session = await this.deps.store.load(sessionId);
    const worktreePath = session.workspace.worktreePath;
    if (!worktreePath) throw new WorkspaceMissingError(sessionId);

    const sessionDir = `${this.deps.sessionsDir}/${sessionId}`;
    const active: ActiveRun = { handle: null, stopRequested: false };
    this.active.set(sessionId, active);
    try {
      await this.deps.fs.mkdir(sessionDir, { recursive: true });
      if (input.brief !== null) await this.deps.fs.writeFile(`${sessionDir}/BRIEF.md`, input.brief);
      await this.deps.fs.writeFile(`${sessionDir}/AGENT_STATE`, 'working');

      const startedAt = this.now().toISOString();
      const running: LastRun = { stage, startedAt, finishedAt: null, exitCode: null, signal: null, outcome: 'running', error: null };
      const previousResumeId = session.agent?.resumeId ?? null;
      session = { ...session, lastRun: running, agent: { runner: this.deps.runnerKind, resumeId: previousResumeId } };
      await this.deps.store.save(session);
      this.deps.events.emit('run.started', { session, stage });

      const exitPromise = new Promise<AgentExitResult>((resolve) => {
        void (async () => {
          const handle = await this.deps.runner.start({
            sessionId,
            workingDirectory: worktreePath,
            additionalDirs: [sessionDir],
            resumeId: previousResumeId ?? undefined,
          });
          active.handle = handle;
          this.deps.runner.onOutput(handle, (chunk) => this.deps.events.emit('run.output', { sessionId, stage, chunk }));
          this.deps.runner.onExit(handle, resolve);
          if (active.stopRequested) await this.deps.runner.stop(handle);
          await this.deps.runner.sendPrompt(handle, input.prompt);
        })().catch((err) => { startupError = err; resolve({ code: null, signal: null }); });
      });
      let startupError: unknown = undefined;
      const exit = await exitPromise;
      if (startupError !== undefined) throw startupError;

      const outcome: StageRunResult['outcome'] = active.stopRequested
        ? 'stopped'
        : exit.code === 0 && exit.signal === null ? 'succeeded' : 'failed';
      const error =
        outcome === 'stopped' ? 'stopped by user'
        : outcome === 'failed' ? (exit.signal ? `agent killed by ${exit.signal}` : `agent exited with code ${exit.code}`)
        : null;
      const resumeId = (active.handle && this.deps.runner.getResumeId?.(active.handle)) ?? previousResumeId;
      session = await this.deps.store.load(sessionId); // re-read: nothing else writes during a run, but never clobber a newer save
      session = {
        ...session,
        lastRun: { ...running, finishedAt: this.now().toISOString(), exitCode: exit.code, signal: exit.signal, outcome, error },
        agent: { runner: this.deps.runnerKind, resumeId },
      };
      await this.deps.store.save(session);
      this.deps.events.emit('run.finished', { session, stage, outcome });
      return { exit, outcome, session };
    } catch (err) {
      const current = await this.deps.store.load(sessionId);
      const failed: LastRun = {
        stage, startedAt: current.lastRun?.startedAt ?? this.now().toISOString(), finishedAt: this.now().toISOString(),
        exitCode: null, signal: null, outcome: 'failed', error: err instanceof Error ? err.message : String(err),
      };
      await this.deps.store.save({ ...current, lastRun: failed });
      this.deps.events.emit('run.finished', { session: { ...current, lastRun: failed }, stage, outcome: 'failed' });
      throw err;
    } finally {
      this.active.delete(sessionId);
    }
  }
}
```
Move the `let startupError` declaration above the `exitPromise` construction (TypeScript will complain about use-before-declare otherwise). Keep the shape: `runner.start` → register `onOutput`/`onExit` → `sendPrompt`; the awaited value is always the exit event.

- [ ] **Step 4: GREEN** — `pnpm test && pnpm typecheck && pnpm lint`. If `no-floating-promises` or similar lint rules fire on the IIFE, satisfy them with `void` as shown, not by disabling the rule.

- [ ] **Step 5: Commit** — `git commit -m "feat(cgremlin-core): StageRunner — one agent turn per call, exit-driven completion, lastRun bookkeeping, stop"`

---

### Task 8: `PipelineService` — investigation, plan gate, promotion, development

**Files:**
- Create: `src/pipeline/pipeline-service.ts`
- Test: `test/pipeline/pipeline-service.investigation.test.ts`

**Interfaces:**
- Consumes: `SessionStore`, `WorkspaceManager`, `StageRunner`, `SessionFileSystem`, `GitRunner`, `EngineEvents`, templates (Task 4), evaluators (Task 5), gate (Task 6).
- Produces:
```ts
export interface PipelineConfig {
  sessionsDir: string;        // absolute
  worktreesDir: string;       // absolute; worktree = `${worktreesDir}/${sessionId}`
  defaultBaseRef: string;     // e.g. 'origin/main'
  reviewSkillCommand?: string;
  includeLiveUiCheck?: boolean;
}
export interface PipelineServiceDeps {
  store: SessionStore; workspace: WorkspaceManager; stageRunner: StageRunner;
  fs: SessionFileSystem; git: GitRunner; events: EngineEvents; config: PipelineConfig;
  now?: () => Date; newId?: (prefix: string, repoSlug: string, key: string) => string;
}
export interface CreateInvestigationInput {
  repoUrl: string; ticket: string | null; intent: 'investigate_only' | 'development';
  driveToCompletion: boolean; baseRef?: string;
}
export class UnsupportedStageError extends Error { name = 'UnsupportedStageError' }   // stage not valid for this session's mode/phase
export class PipelineService {
  constructor(deps: PipelineServiceDeps)
  createInvestigationSession(input: CreateInvestigationInput): Promise<InvestigationSession>
  runFindings(id: string): Promise<Session>
  runPlan(id: string): Promise<Session>
  approvePlan(id: string): Promise<Session>
  promote(id: string): Promise<{ investigation: Session; development: Session }>
  runDevelop(id: string): Promise<Session>
  runStage(id: string, stage: StageName): Promise<Session>   // dispatcher used by the API
  stop(id: string): Promise<boolean>
  retry(id: string): Promise<Session>                       // re-runs lastRun.stage; UnsupportedStageError if none
  repoSlug(repoUrl: string): string                         // 'owner/name' → also used for ids
}
```
  Rules (all via `store.transition`, never direct assignment):
  - `createInvestigationSession`: id = `newId('inv', slug, ticket ?? 'no-ticket')` (default: `${prefix}-${slug.replace('/', '-')}-${key}-${yyyymmdd-HHMMSS from now()}`); branch `investigate/${ticket ?? id}`; `workspace.createWorkspace({ repoUrl, worktreePath, branchName, baseRef, mode: 'investigation' })`; save v2 session at `findings` with `intent`, `driveToCompletion`, `pipelineId = id`, `parentSessionId = null`; emit `session.created`. If `createWorkspace` throws, nothing is saved.
  - `runFindings`: only when `stageStatus === 'findings'` (else `UnsupportedStageError`). Brief = `renderFindingsBrief`, prompt = `STAGE_ENTRY_PROMPT(sessionDir)`. After a `succeeded` run with `hasFindings`: if `intent === 'development'` → return `await this.runPlan(id)`; else return session unchanged (still `findings`, artifacts visible). If run failed or `!hasFindings`: set `lastRun.error` to `'run succeeded but FINDINGS.md is missing or empty'` when applicable and return (phase unchanged).
  - `runPlan`: allowed from `findings` (requires `hasFindings`, else `UnsupportedStageError('FINDINGS.md missing')`) or `planning` (retry). From `findings`: transition `findings → planning` **before** the run. Brief = `renderPlanBrief`, prompt = `STAGE_ENTRY_PROMPT`. After `succeeded`: `evaluatePlan` → `approved` ⇒ transition `planning → plan_ready`, then if `driveToCompletion` ⇒ `await this.promote(id)` and return the (now `promoted_to_development`) investigation session; `unresolved` ⇒ stay `planning`, set `lastRun.error = 'unresolved review disagreement — needs input'`; `missing` ⇒ stay `planning`, `lastRun.error = 'run succeeded but PLAN.md has no approved Review Status'`, `outcome: 'failed'`.
  - `approvePlan`: `plan_ready → approved`.
  - `promote`: `assertCanPromote`; transition investigation `→ promoted_to_development`; create development session `{ id: newId('dev', slug, ticket ?? inv.id), mode: 'development', stageStatus: 'active', workspace: inv.workspace (same worktreePath/branch), lineage: { pipelineId: inv.lineage.pipelineId, parentSessionId: inv.id, ticket: inv.lineage.ticket }, agent: null, lastRun: null, pr: null }`; **copy** `FINDINGS.md` and `PLAN.md` from the investigation session dir into the development session dir (the develop brief reads them from its own session dir); emit `session.created`; then `await this.runDevelop(dev.id)`; return both.
  - `runDevelop`: only for `development` sessions at `active`; brief = `renderDevelopBrief({ hasPlan: PLAN.md exists })`; prompt = `STAGE_ENTRY_PROMPT`. No transition on success (PR detection is 3b).
  - `runStage(id, stage)`: `findings → runFindings`, `plan → runPlan`, `develop → runDevelop`, `review → runReview`, `rereview → runRereview` (Task 9); `UnsupportedStageError` if the session's mode does not own that stage.
  - `retry`: `lastRun` null ⇒ `UnsupportedStageError`; else `runStage(id, lastRun.stage)`.

- [ ] **Step 1: Write the failing tests** (`test/pipeline/pipeline-service.investigation.test.ts`)

Build a `harness()` that wires `InMemoryFileSystem`, `SessionStore('/sessions')`, `FakeGitRunner`, `WorkspaceManager(git, fs, '/mirrors')`, `FakeAgentRunner`, `EngineEvents`, `StageRunner`, and `PipelineService` with `now = () => new Date('2026-09-04T12:00:00.000Z')` and `config = { sessionsDir: '/sessions', worktreesDir: '/worktrees', defaultBaseRef: 'origin/main' }`. Because `StageRunner.run` only resolves on `onExit`, tests drive the fake like Task 7: start the service call, flush microtasks (`await new Promise(r => setTimeout(r, 0))`), write artifacts into `/sessions/<id>/…` with the fs, then `runner.emitExit(handle, …)`. Provide a helper `finishRun(runner, files, exit)` that does exactly that against the most recent handle.

Tests (each is an `it`):
1. `createInvestigationSession` creates the worktree at `/worktrees/<id>` on branch `investigate/APP-1` from `origin/main`, saves a v2 session at `findings` with `intent`/`driveToCompletion`, `pipelineId === id`, and emits `session.created`. Assert the `FakeGitRunner` saw `worktree add /worktrees/<id> -b investigate/APP-1 origin/main`.
2. If `createWorkspace` rejects, no session is saved (`store.list()` is empty) and the error propagates.
3. `runFindings` with `intent: 'investigate_only'`: writes BRIEF.md containing `FINDINGS.md`, sends the entry prompt; after exit 0 with `FINDINGS.md` written, phase stays `findings`, `lastRun.outcome === 'succeeded'`, and **no second prompt** was sent.
4. `runFindings` with `intent: 'development'`: after exit 0 + FINDINGS.md, the service transitions to `planning` and starts a second run whose BRIEF.md contains `## Review Status` (i.e. the plan brief), on a handle whose `ctx.resumeId` equals the resume id set on the first handle.
5. `runFindings` exit 0 but no FINDINGS.md ⇒ phase `findings`, `lastRun.outcome === 'failed'`, error mentions `FINDINGS.md`.
6. `runPlan` from `findings` without FINDINGS.md ⇒ rejects `UnsupportedStageError` and no run started (`runner` has no handles).
7. `runPlan` approved + `driveToCompletion: false` ⇒ `plan_ready`; `promote` then rejects `PlanGateError`; `approvePlan` ⇒ `approved`; `promote` ⇒ investigation `promoted_to_development`, new development session at `active` with `parentSessionId`, same `pipelineId`, same `workspace`, and `/sessions/<dev>/PLAN.md` + `FINDINGS.md` copied; a develop run has started with BRIEF.md containing `PLAN.md (your approved plan)`.
8. `runPlan` approved + `driveToCompletion: true` ⇒ chains straight through to `promoted_to_development` and a running development session (no `approvePlan` call).
9. `runPlan` with `## Unresolved Review Disagreement` ⇒ phase stays `planning`, `lastRun.error` contains `needs input`, outcome `succeeded` (the agent did its job; a human is needed).
10. `runPlan` exit 0 without Review Status ⇒ stays `planning`, `lastRun.outcome === 'failed'`.
11. **Mutation guard for the gate:** a test that calls `promote` on a `plan_ready` + `driveToCompletion: false` session and expects `PlanGateError`, and a sibling that calls `promote` on `planning` + `driveToCompletion: true` and expects `PlanGateError`. (If someone deletes `assertCanPromote` from `promote`, both fail.)
12. `runStage(id, 'review')` on an investigation ⇒ `UnsupportedStageError`; `retry` with no `lastRun` ⇒ `UnsupportedStageError`; `retry` after a failed findings run re-runs `findings` (a new handle appears).
13. `stop(id)` during a findings run ⇒ `lastRun.outcome === 'stopped'`, phase unchanged.

Write these out in full in the test file (they are the spec of the service; do not abbreviate to comments).

- [ ] **Step 2: RED** — module not found.

- [ ] **Step 3: Implement** `src/pipeline/pipeline-service.ts` following the rules above. Skeleton:
```ts
export class PipelineService {
  private readonly now: () => Date;
  private readonly newId: (prefix: string, repoSlug: string, key: string) => string;
  constructor(private readonly deps: PipelineServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? ((prefix, slug, key) => `${prefix}-${slug.replace('/', '-')}-${key}-${stamp(this.now())}`);
  }
  private sessionDir(id: string) { return `${this.deps.config.sessionsDir}/${id}`; }
  private async transition(id: string, to: string): Promise<Session> {
    const before = await this.deps.store.load(id);
    const after = await this.deps.store.transition(id, to);
    this.deps.events.emit('session.transitioned', { session: after, from: before.stageStatus, to });
    return after;
  }
  private async patchLastRun(id: string, patch: Partial<LastRun>): Promise<Session> {
    const s = await this.deps.store.load(id);
    if (!s.lastRun) return s;
    const updated = { ...s, lastRun: { ...s.lastRun, ...patch } };
    await this.deps.store.save(updated);
    return updated;
  }
  // ... methods per the rules
}
function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}
export function repoSlug(repoUrl: string): string {
  const m = repoUrl.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : repoUrl.replace(/[^a-zA-Z0-9._-]/g, '-');
}
```
Copying artifacts on promote: `for (const name of ['FINDINGS.md', 'PLAN.md']) { const src = `${invDir}/${name}`; if (await fs.exists(src)) await fs.writeFile(`${devDir}/${name}`, await fs.readFile(src)); }`.

- [ ] **Step 4: GREEN** — `pnpm test && pnpm typecheck && pnpm lint`.
- [ ] **Step 5: Commit** — `git commit -m "feat(cgremlin-core): PipelineService — investigation findings/plan runs, plan gate, promotion to development, develop run"`

---

### Task 9: `PipelineService` — review and re-review

**Files:**
- Modify: `src/pipeline/pipeline-service.ts`
- Test: `test/pipeline/pipeline-service.review.test.ts`

**Interfaces:**
- Produces on `PipelineService`:
```ts
runReview(id: string): Promise<Session>
runRereview(id: string): Promise<Session>
```
  Rules:
  - `runReview`: review sessions only; allowed from `queued`, `changes_requested`, `ready`, `failed` (`UnsupportedStageError` otherwise, e.g. `approved`/`dismissed`/`reviewing`). Requires `session.pr` (else `UnsupportedStageError('review session has no pr')`). Transition `→ reviewing` before the run. Brief = `null` (legacy review runs on the worktree's own `CLAUDE.md`; the prompt is self-contained). Prompt = `renderReviewPrompt({ sessionDir, reviewSkillCommand, includeLiveUiCheck })`. After the run: `evaluateReview(exit, fs, sessionDir)` ⇒ `ready` ⇒ transition `reviewing → ready` and set `pr.reviewedSha = pr.headSha` (if known); `failed` ⇒ transition `reviewing → failed`. A `stopped` run ⇒ `failed` too.
  - `runRereview`: review sessions only; allowed from `ready`, `changes_requested`, `failed`. Steps, in the worktree (`cwd = worktreePath`, via `deps.git`):
    1. `oldCommit = git rev-parse HEAD`.
    2. `git fetch origin pull/<pr.number>/head`.
    3. `newCommit = git rev-parse FETCH_HEAD`.
    4. `git reset --hard FETCH_HEAD`.
    5. `newCommitsText = git log --oneline <old>..<new>`; `commitCount` = non-empty line count; `changesSince = git diff --stat <old>...HEAD`.
    6. Archive: `v = nextReviewVersion(fs, sessionDir)`; if `REVIEW.md` non-empty, copy to `REVIEW-v${v}.md`; set `reviewVersion = v`.
    7. Write `RE-REVIEW.md` in the session dir with: `# RE-REVIEW — PR #<n>`, `Previous review: REVIEW-v<v>.md`, `Reviewed commit: <old>` → `New head: <new>`, a `## New commits` block with `newCommitsText`, a `## Changes since last review` block with `changesSince`.
    8. Transition `→ reviewing`; run with prompt `renderRereviewPrompt({ sessionDir, commitCount, reviewSkillCommand })`, brief `null`.
    9. After: `evaluateRereview` ⇒ `ready` ⇒ transition `→ ready`, `pr.reviewedSha = newCommit`, `pr.headSha = newCommit`; `failed` ⇒ `→ failed`.
    If any git step throws before the run starts, nothing is transitioned and the error propagates.

- [ ] **Step 1: Write the failing tests** (`test/pipeline/pipeline-service.review.test.ts`), same harness as Task 8 plus a review session fixture:
```ts
const review = migrateV1ToV2({
  schemaVersion: 1, id: 'pr-app-12-x', mode: 'review', createdAt: '2026-09-04T10:00:00.000Z',
  workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath: '/worktrees/pr-app-12-x', branch: 'pr-12' },
  lineage: { pipelineId: 'pr-app-12-x', parentSessionId: null, ticket: null }, stageStatus: 'queued',
});
review.pr = { repo: 'acme/app', number: 12, url: 'https://github.com/acme/app/pull/12', headSha: 'aaa', reviewedSha: null, title: 'T', author: 'bob' };
```
Tests:
1. `runReview` from `queued`: transitions to `reviewing` before the prompt is sent (assert phase while the run is pending); prompt equals `renderReviewPrompt({ sessionDir: '/sessions/pr-app-12-x' })`; brief file not written; exit 0 + non-empty REVIEW.md ⇒ `ready`, `pr.reviewedSha === 'aaa'`.
2. exit 0 with empty REVIEW.md ⇒ `failed`. **Mutation guard:** exit 1 with a non-empty REVIEW.md ⇒ `failed` (if `evaluateReview` stops checking the exit code, this fails).
3. `runReview` from `approved` ⇒ `UnsupportedStageError`; from `reviewing` ⇒ `UnsupportedStageError`; without `pr` ⇒ `UnsupportedStageError`; `failed → reviewing → ready` retry path works.
4. `runRereview` from `changes_requested` with `REVIEW.md` = `'old review'` and no archives: `FakeGitRunner` scripted so `rev-parse HEAD` → `aaa`, `rev-parse FETCH_HEAD` → `bbb`, `log --oneline aaa..bbb` → two lines, `diff --stat` → `' 1 file changed'`. Assert git argv sequence in the worktree cwd: `['rev-parse','HEAD']`, `['fetch','origin','pull/12/head']`, `['rev-parse','FETCH_HEAD']`, `['reset','--hard','FETCH_HEAD']`, `['log','--oneline','aaa..bbb']`, `['diff','--stat','aaa...HEAD']`. Assert `REVIEW-v1.md === 'old review'`, `RE-REVIEW.md` contains both commit lines and the two log lines, the prompt contains `PR updated with 2 new commit(s)`, session `reviewVersion === 1`, phase `reviewing` during the run; after exit 0 + REVIEW.md + `rereview_summary` `'✅ 2/2 resolved'` ⇒ `ready`, `pr.reviewedSha === 'bbb'`, `pr.headSha === 'bbb'`.
5. `runRereview` again (now with `REVIEW-v1.md` present) archives to `REVIEW-v2.md` and `reviewVersion === 2`.
6. `runRereview` from `ready` is allowed (spec ruling 4); from `queued` ⇒ `UnsupportedStageError`.
7. If `git fetch` rejects, `runRereview` rejects, phase is unchanged, no archive was written, no prompt was sent.

`test/support/fake-git-runner.ts` records every call in `calls` (`{ args, cwd }`) and serves canned results FIFO via `queueResponse({ stdout, stderr } | Error)`; an empty queue yields `{ stdout: '', stderr: '' }`. Script the re-review sequence by queueing six responses in call order (`aaa`, `''`, `bbb`, `''`, two log lines, the diffstat). For test 7 queue `{stdout:'aaa',stderr:''}` then an `Error('fetch failed')`.

- [ ] **Step 2: RED**.
- [ ] **Step 3: Implement** per the rules. Re-review brief file content:
```ts
const reReview = [
  `# RE-REVIEW — PR #${pr.number}`,
  ``,
  `Previous review: REVIEW-v${version}.md`,
  `Reviewed commit: ${oldCommit}`,
  `New head: ${newCommit}`,
  ``,
  `## New commits (${commitCount})`,
  newCommitsText || '(none listed)',
  ``,
  `## Changes since last review`,
  changesSince || '(no diffstat)',
  ``,
].join('\n');
```
- [ ] **Step 4: GREEN** — `pnpm test && pnpm typecheck && pnpm lint`.
- [ ] **Step 5: Commit** — `git commit -m "feat(cgremlin-core): PipelineService review and re-review runs with archive versioning and diff-aware prompt"`

---

### Task 10: Shared-workspace refusal

**Files:**
- Create: `src/workspace/workspace-in-use.ts`
- Test: `test/workspace/workspace-in-use.test.ts`

**Interfaces:**
```ts
export const TERMINAL_PHASES: ReadonlySet<string>  // promoted_to_development, abandoned, merged, dismissed, approved
export class WorkspaceInUseError extends Error { name = 'WorkspaceInUseError' }
export function findSessionsUsingWorktree(sessions: readonly Session[], worktreePath: string, excludeSessionId?: string): Session[]
   // non-terminal sessions whose workspace.worktreePath === worktreePath, excluding excludeSessionId
export function assertWorktreeNotInUse(sessions: readonly Session[], worktreePath: string, excludeSessionId?: string): void
```
Note `approved` is terminal for review sessions but is NOT terminal for investigation sessions (an approved investigation still owns its worktree until promoted). Implement terminality per mode: investigation `{promoted_to_development, abandoned}`, development `{merged, abandoned}`, review `{approved, dismissed}`.

- [ ] **Step 1: Write the failing tests** covering: an `active` development session sharing the worktree blocks removal; a `promoted_to_development` investigation does not; an `approved` investigation **does** block; an `approved` review does not; `excludeSessionId` excludes the caller's own session; `assertWorktreeNotInUse` throws `WorkspaceInUseError` naming the blocking ids.
- [ ] **Step 2: RED.** **Step 3: Implement.** **Step 4: GREEN.**
- [ ] **Step 5: Commit** — `git commit -m "feat(cgremlin-core): shared-worktree in-use detection for workspace teardown"`

---

### Task 11: API routes, request validation, error mapping

**Files:**
- Modify: `src/api/server.ts`, `src/api/validation.ts`, `src/api/http-errors.ts`
- Test: `test/api/server.test.ts` (extend), `test/api/http-errors.test.ts`, `test/api/validation.test.ts`

**Interfaces:**
- `ApiServerDeps` gains `pipeline: PipelineService` and `sessionsDir: string` (for artifact reads) and `fs: SessionFileSystem`.
- Routes (all `:id` routes wrapped in `lock.withLock(id, …)`):
  - `POST /sessions/investigations` body `CreateInvestigationInput` (zod: `repoUrl` min 1, `ticket` nullable string, `intent` enum, `driveToCompletion` boolean, `baseRef` optional) → 201 `{ session }`.
  - `POST /sessions/:id/run` body `{ stage: StageName }` → 202 `{ session }` where `session` is the state **after the run started** (the run continues in the background; the promise from `runStage` is awaited only for the pre-run transition). Implementation: the handler calls `pipeline.runStage(id, stage)` and races it against a short "started" signal — simplest correct approach: `runStage` is invoked without awaiting the whole run; the handler awaits `events` `run.started` for that id (or the rejection of `runStage` if it fails before starting, e.g. `UnsupportedStageError`/`RunInProgressError`), then responds with `store.load(id)`. Unhandled rejections from the detached run must be caught and emitted as `run.finished` failures (StageRunner already records them) — attach `.catch(() => {})` after the failure has been persisted by the service.
  - `POST /sessions/:id/approve-plan` → 200 `{ session }`.
  - `POST /sessions/:id/promote` → 202 `{ investigation, development }` (develop run detached the same way).
  - `POST /sessions/:id/rereview` → 202 `{ session }`.
  - `POST /sessions/:id/stop` → 200 `{ stopped: boolean }`.
  - `POST /sessions/:id/retry` → 202 `{ session }`.
  - `GET /sessions/:id/artifacts/:name` → 200 `text/plain; charset=utf-8` body, 404 `ArtifactNotFoundError` if missing; `name` must match `/^(FINDINGS|PLAN|DEVELOPMENT|REVIEW|RE-REVIEW|BRIEF|REVIEW-v\d+)\.md$|^AGENT_(NOTE|STATE)$|^rereview_summary$|^PR_URL$/`, else 400 `ValidationError`.
  - `DELETE /workspaces` now calls `assertWorktreeNotInUse(await store.list(), body.worktreePath)` first → 409 on `WorkspaceInUseError`.
- `mapErrorToHttp` additions: `PlanGateError`, `RunInProgressError`, `WorkspaceInUseError`, `UnsupportedStageError` → 409; `WorkspaceMissingError` → 409; `ArtifactNotFoundError` → 404.

- [ ] **Step 1: Write the failing tests.** Extend `test/api/server.test.ts` to construct `PipelineService` with the fakes (reuse the Task 8 harness pieces; factor a `test/support/pipeline-harness.ts` if both test files need it) and add:
  1. `POST /sessions/investigations` → 201, session at `findings`, worktree created (`FakeGitRunner` saw `worktree add`).
  2. `POST /sessions/:id/run {stage:'findings'}` → 202 with `lastRun.outcome === 'running'`; then complete the fake run and `GET /sessions/:id` shows `succeeded`.
  3. `POST /sessions/:id/run` twice while running → second is 409 `RunInProgressError`.
  4. `POST /sessions/:id/run {stage:'review'}` on an investigation → 409 `UnsupportedStageError`; `{stage:'bogus'}` → 400.
  5. `POST /sessions/:id/promote` on `plan_ready` without drive → 409 `PlanGateError`; after `approve-plan` → 202 with both sessions.
  6. `GET /sessions/:id/artifacts/PLAN.md` → 200 text; missing → 404; `../session.json` → 400; `REVIEW-v2.md` → allowed.
  7. `DELETE /workspaces` for a worktree referenced by an `active` development session → 409; after that session is `abandoned` → 204.
  8. `POST /sessions/:id/stop` while running → `{ stopped: true }`; when idle → `{ stopped: false }`.
  Add to `test/api/http-errors.test.ts` one assertion per new error name → status.
- [ ] **Step 2: RED.** **Step 3: Implement.** Keep `handleRequest` readable: extract a `routeSession(parts, req, res)` helper if the function exceeds ~150 lines.
- [ ] **Step 4: GREEN** — `pnpm test && pnpm typecheck && pnpm lint`.
- [ ] **Step 5: Commit** — `git commit -m "feat(cgremlin-core): pipeline API routes (investigations, run, approve-plan, promote, rereview, stop, retry, artifacts), in-use workspace guard, error mapping"`

---

## Definition of Done

- `pnpm test && pnpm typecheck && pnpm lint` green from `cgremlin/core/`.
- All of the following exist with the signatures above: `STAGE_NAMES`/`LastRunSchema`/`AgentSchema`/`PrSchema`; `SessionSchema` v2 with `migrateV1ToV2` and a `parseSession` that accepts v1; `failed` review phase and `ready → reviewing`; `SessionContext.additionalDirs/resumeId`; `ClaudeCodeRunner --add-dir` pinned by an exact-argv test; `DEFAULT_PERMISSIONS` without `cgremlin --`; `renderFindingsBrief/renderPlanBrief/renderDevelopBrief/renderReviewPrompt/renderRereviewPrompt/STAGE_ENTRY_PROMPT`; `evaluateFindings/evaluatePlan/parsePlanReviewStatus/evaluateReview/evaluateRereview/parseRereviewSummary/nextReviewVersion`; `canPromote/assertCanPromote/PlanGateError`; `EngineEvents`; `StageRunner` with `RunInProgressError/WorkspaceMissingError`; `PipelineService` with every method in Tasks 8–9; `findSessionsUsingWorktree/assertWorktreeNotInUse/WorkspaceInUseError`; the API routes in Task 11.
- The four mutation guards from spec §6 are present as tests and were each shown to fail when the guarded code was removed (the executor reports the exact mutation tried and the failing test name for each; the supervising session reproduces at least two).
- No engine code path issues a `gh` command or any GitHub-mutating command (grep `src/` for `'gh'` returns nothing in 3a).
- No brief or prompt contains `cgremlin --` (covered by tests in Task 4).
- `.superpowers/sdd/2026-09-04-cgremlin-core-phase3a-pipeline-engine/progress.md` in the worktree records per-task status, reviewer findings, and rulings.
- Explicitly **not** in this plan: `GhRunner`, PR discovery, review-session creation from a PR URL, lineage linking, reconciliation tick (Phase 3b); any GitHub write; own-PR triage; `CodexRunner`; log persistence to disk (events only).
