# cgremlin step 1 — Harden the development guard; stage-aware profiles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The `development` guard profile denies `gh pr ready/edit/merge/close`, `gh api:*` and every force-push spelling, and `PermissionSubject` gains a `stage` so a review or live-check stage running in a dev worktree cannot commit or push.

**Architecture:** All policy stays in `permissionProfileFor` + `DEFAULT_PERMISSIONS` (`cgremlin/core/src/workspace/permission-guard.ts`). `development` gets a hardened deny list. Two new profiles, `development:inspect` and `investigation:development:inspect`, are the existing dev-landing profiles plus `git commit`/`git push` denies; `permissionProfileFor` selects them when a dev-landing subject carries an inspect stage. The stage runner already refreshes the guard before every run, so it passes `stage` there. Nothing else changes: respond, QA, review and `review:conversation` resolve exactly as today.

**Tech Stack:** TypeScript, vitest, pnpm (`cgremlin/core`, `cgremlin/vscode`).

**Spec:** `docs/superpowers/specs/2026-09-30-cgremlin-plan-sessions-design.md` — R92, R112, §0 guard rows. Program card: `docs/superpowers/plans/2026-10-05-cgremlin-program.md` step 1 (lines 100-110).

## Global Constraints

- Change only cgremlin (`~/context-gremlin`); never team repos. `bin/cgremlin` is frozen (A5).
- TDD for behaviour; `pnpm test`, `pnpm typecheck`, `pnpm lint` pass in `cgremlin/core` AND `cgremlin/vscode` before release.
- Worktree `.claude/worktrees/1`, branch `step/1`, branched from `mission-control-pr-orchestrator`. Commit frequently.
- Protected actions (open PR for review, merge, approve, post findings on others' PRs) need the user's explicit approval (R112). Headless runs never do them.
- 0c's preflight (`src/pipeline/preflight.ts`, `test/pipeline/preflight.test.ts`, `test/pipeline/pipeline-service.preflight.test.ts`) is **not touched**. Step 1 changes the permission guard only.
- `development` keeps: `git commit`, `git push` of its own branch, `gh pr create --draft`, and the whole non-pr/issue/api `gh` surface (`ADMINISTRATIVE_GH` test stays green). `--force-with-lease` stays DENIED (card: allow only when a later step needs it — not yet).
- Never read `~/.cgremlin/config` or `~/.cgremlin-core*/core.json`.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (or the model actually used).
- Guard is a guardrail, not a boundary (header comment): do not claim a rule "prevents" a class of behaviour.

## Review Focus

1. `git push origin +my-branch` / `HEAD:refs/heads/x --force` / `-f` anywhere in the line, in `development` → denied (flag-less `+refspec` and late-flag spellings must not slip past).
2. `gh api -X POST …`, `gh api graphql …`, `gh pr ready --undo`, `gh pr edit 12 --title x` in `development` → denied; `gh pr create --draft` and plain `git push -u origin HEAD` → still allowed.
3. A `development` session (or development-bound investigation) running stage `review`/`rereview`/`phase_review`/`live_check` → `git commit`/`git push` denied; the SAME session running `develop`/`plan`/`findings` or with no stage → can still commit and push (an unstaged caller must behave as today).
4. A worktree created under the OLD permissive table gets the new table on its next stage run (the refresh is the only writer; no stale `settings.local.json` survives).
5. A `review`-mode / `respond` / `qa` session with any `stage` value resolves to the same profile as without it, and a review claimed by the user (`conversation: true`) still resolves to `review:conversation`.

---

### Task 1: Harden the `development` profile

**Files:**
- Modify: `cgremlin/core/src/workspace/permission-guard.ts:283-289` (the `development` entry)
- Modify: `cgremlin/core/test/workspace/permission-guard.test.ts` (lines ~66-73, ~184-190, ~535-540, plus new describe)

**Interfaces:**
- Consumes: existing constants `NEVER_POST`, `NEVER_LAND`, `GH_API_DENY`, `NEVER_FORCE_PUSH`.
- Produces: `DEFAULT_PERMISSIONS.development.deny` = `[...NEVER_POST, ...NEVER_LAND, GH_API_DENY, ...NEVER_FORCE_PUSH]` (this order; Task 2 spreads it).

- [ ] **Step 1: Write the failing tests.** Append to `permission-guard.test.ts` (uses the file's existing `matchesRule`; add a profile-keyed helper next to `isDenied`):

```ts
const isProfileDenied = (profile: keyof typeof DEFAULT_PERMISSIONS, command: string): boolean =>
  (DEFAULT_PERMISSIONS[profile].deny ?? []).some((rule) => matchesRule(rule, command));

describe('step 1 — development no longer lands, rewrites or calls the API', () => {
  it.each([
    'gh pr ready 12',
    'gh pr ready --undo',
    'gh pr edit 12 --title x',
    'gh pr merge 12 --squash',
    'gh pr close 12',
    'gh api repos/acme/app/pulls/12',
    'gh api -X POST repos/acme/app/issues',
    'gh api graphql -f query=x',
    'git push --force',
    'git push -f origin my-branch',
    'git push origin my-branch --force',
    'git push origin my-branch -f',
    'git push --force-with-lease origin my-branch',
    'git push origin my-branch --force-with-lease=refs/heads/my-branch:0ff1ce',
    'git push origin +my-branch',
    'git push origin +HEAD:my-branch',
  ])('denies `%s`', (command) => {
    expect(isProfileDenied('development', command)).toBe(true);
  });

  it.each([
    'git commit -m x',
    'git push',
    'git push -u origin HEAD',
    'git push origin my-branch',
    'gh pr create --draft --title x',
    'gh pr view 12',
    'gh run list',
  ])('still allows `%s`', (command) => {
    expect(isProfileDenied('development', command)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure.** `cd cgremlin/core && pnpm vitest run test/workspace/permission-guard.test.ts -t "step 1"` → FAIL (ready/edit/api/force denials missing).

- [ ] **Step 3: Implement.** Replace the `development` entry:

```ts
  // Step 1 — the human's own development session. It commits, pushes its own
  // branch and opens a DRAFT pull request (`gh pr create --draft`; the engine
  // re-checks isDraft). It does not mark a PR ready, edit it, merge or close
  // it, call `gh api`, or rewrite history: those are protected actions (R112)
  // and force-pushing is denied in every spelling, `--force-with-lease`
  // included until a later step needs it. Deliberately NOT denied: the rest of
  // the `gh` surface (NEVER_ADMINISTER) — this profile is the one that keeps it.
  development: {
    deny: [
      ...NEVER_POST,
      ...NEVER_LAND,
      GH_API_DENY,
      ...NEVER_FORCE_PUSH,
    ],
  },
```

- [ ] **Step 4: Update the three existing tests that pin the old table.**
  - Test at ~line 66: keep as is (merge/close still present, push/pr-create still absent) — verify it passes.
  - The `toEqual` table at ~line 184: replace the `development.deny` array with the new order: `gh pr review`, `gh pr comment`, `gh issue`, `gh pr merge`, `gh pr close`, `gh pr edit`, `gh pr ready`, `gh api:*`, then the 12 `NEVER_FORCE_PUSH` strings exactly as listed in the `investigation:development` entry of that same `toEqual`.
  - ~line 535 `development is untouched by this phase…` — retitle to `development keeps the non-pr/issue/api gh surface (step 1 hardens only pr/api/force-push)`; body unchanged.

- [ ] **Step 5: Run the file.** `pnpm vitest run test/workspace/permission-guard.test.ts` → PASS. Also `pnpm vitest run test/pipeline/preflight.test.ts test/pipeline/pipeline-service.preflight.test.ts` → PASS (untouched).

- [ ] **Step 6: Commit.**

```bash
git add cgremlin/core/src/workspace/permission-guard.ts cgremlin/core/test/workspace/permission-guard.test.ts
git commit -m "feat(cgremlin-core): development denies gh pr ready/edit, gh api and every force-push spelling"
```

---

### Task 2: `stage` on `PermissionSubject` and the inspect profiles

**Files:**
- Modify: `cgremlin/core/src/workspace/permission-guard.ts` (imports; `PermissionSubject`; `PermissionProfile`; `permissionProfileFor`; `DEFAULT_PERMISSIONS`)
- Modify: `cgremlin/core/src/workspace/post-helpers.ts` (only if `POSTING_PROFILES`/exhaustive switches fail typecheck — inspect profiles must NOT post)
- Modify: `cgremlin/core/test/workspace/permission-guard.test.ts` (table pin + new tests)

**Interfaces:**
- Consumes: `StageName` from `../schema/stage`; `DEFAULT_PERMISSIONS.development`, `DEFAULT_PERMISSIONS['investigation:development']`.
- Produces:
  - `export type GuardStage = StageName | 'phase_review' | 'live_check';`
  - `export const INSPECT_STAGES: readonly GuardStage[] = ['review', 'rereview', 'phase_review', 'live_check'];`
  - `PermissionSubject.stage?: GuardStage`
  - `PermissionProfile` additionally includes `'development:inspect' | 'investigation:development:inspect'`.
  - `permissionProfileFor` mapping: stage ∈ `INSPECT_STAGES` AND base profile is `development` → `development:inspect`; base `investigation:development` → `investigation:development:inspect`; every other (mode, intent, conversation, stage) combination resolves as today.

- [ ] **Step 1: Write the failing tests.**

```ts
describe('step 1 — a dev worktree running an inspect stage cannot commit or push', () => {
  const DEV = { mode: 'development' } as const;
  const DEV_INV = { mode: 'investigation', intent: 'development' } as const;

  it.each(['review', 'rereview', 'phase_review', 'live_check'] as const)(
    'stage %s denies commit and push in both dev-landing sessions',
    async (stage) => {
      for (const base of [DEV, DEV_INV]) {
        const deny = await denyListFor({ ...base, stage });
        expect(deny).toEqual(expect.arrayContaining(['Bash(git commit:*)', 'Bash(git push:*)']));
      }
    },
  );

  it.each(['findings', 'plan', 'develop', 'respond', 'verify', undefined] as const)(
    'stage %s leaves commit and push to the dev-landing sessions',
    async (stage) => {
      for (const base of [DEV, DEV_INV]) {
        const deny = await denyListFor({ ...base, stage });
        expect(deny).not.toContain('Bash(git commit:*)');
        expect(deny).not.toContain('Bash(git push:*)');
      }
    },
  );

  it('an inspect stage keeps every other development denial', () => {
    expect(DEFAULT_PERMISSIONS['development:inspect'].deny).toEqual([
      ...DEFAULT_PERMISSIONS.development.deny!,
      'Bash(git commit:*)',
      'Bash(git push:*)',
    ]);
    expect(DEFAULT_PERMISSIONS['investigation:development:inspect'].deny).toEqual([
      ...DEFAULT_PERMISSIONS['investigation:development'].deny!,
      'Bash(git commit:*)',
      'Bash(git push:*)',
    ]);
  });

  it('the inspect profiles still do not post', () => {
    expect(permissionProfileFor({ ...DEV, stage: 'review' })).toBe('development:inspect');
    expect(permissionProfileFor({ ...DEV_INV, stage: 'review' })).toBe('investigation:development:inspect');
    expect(shouldWritePostHelpers('development:inspect')).toBe(false);
    expect(shouldWritePostHelpers('investigation:development:inspect')).toBe(false);
  });

  it('stage changes nothing for respond, qa, review or a plain investigation', () => {
    for (const mode of ['respond', 'qa', 'review'] as const) {
      for (const stage of ['review', 'develop', undefined] as const) {
        expect(permissionProfileFor({ mode, stage })).toBe(permissionProfileFor({ mode }));
      }
    }
    expect(permissionProfileFor({ mode: 'investigation', intent: 'investigate_only', stage: 'review' })).toBe('investigation');
    expect(permissionProfileFor({ mode: 'review', conversation: true, stage: 'review' })).toBe('review:conversation');
  });
});
```

Add `shouldWritePostHelpers` to the file's imports from `'../../src/workspace/post-helpers'`.

- [ ] **Step 2: Run to verify failure.** `pnpm vitest run test/workspace/permission-guard.test.ts -t "step 1"` → FAIL (type errors / missing profiles).

- [ ] **Step 3: Implement.** In `permission-guard.ts`:

```ts
import type { StageName } from '../schema/stage';

/**
 * The stage a run is in. `phase_review` and `live_check` are named here ahead
 * of the stage list (`StageName`) so the guard is already right the day those
 * stages exist (R92); until then they are simply never passed.
 */
export type GuardStage = StageName | 'phase_review' | 'live_check';

/** Stages that LOOK at a dev worktree and must never change it (R92). */
export const INSPECT_STAGES: readonly GuardStage[] = ['review', 'rereview', 'phase_review', 'live_check'];
```

`PermissionSubject` gains:

```ts
  /**
   * R92 — the stage this run is in. Absent is "no stage known" and resolves as
   * before. Only the two dev-landing profiles read it: a review or live-check
   * stage running in a dev worktree inherits that worktree's branch, and must
   * not commit or push to it.
   */
  stage?: GuardStage;
```

`PermissionProfile` adds `| 'development:inspect' | 'investigation:development:inspect'`. Rewrite `permissionProfileFor`:

```ts
export function permissionProfileFor(subject: PermissionSubject): PermissionProfile {
  const inspecting = subject.stage !== undefined && INSPECT_STAGES.includes(subject.stage);
  if (subject.mode === 'investigation' && subject.intent === 'development') {
    return inspecting ? 'investigation:development:inspect' : 'investigation:development';
  }
  if (subject.mode === 'development' && inspecting) return 'development:inspect';
  // R110 — (unchanged comment)
  if (subject.mode === 'review' && subject.conversation === true) {
    return 'review:conversation';
  }
  return subject.mode;
}
```

Add after the `development` entry in `DEFAULT_PERMISSIONS` (define `const NEVER_COMMIT = ['Bash(git commit:*)', 'Bash(git push:*)'] as const;` near `NEVER_FORCE_PUSH` and reuse it):

```ts
  // R92 — a review / live-check stage running in a dev worktree: everything the
  // profile it came from denies, plus commit and push.
  'development:inspect': { deny: [...development deny, ...NEVER_COMMIT] },
  'investigation:development:inspect': { deny: [...investigation:development deny, ...NEVER_COMMIT] },
```

Since object literal entries cannot reference each other, hoist the two base deny arrays into `const DEVELOPMENT_DENY = [...] as const;` and `const INVESTIGATION_DEVELOPMENT_DENY = [...] as const;` above `DEFAULT_PERMISSIONS` and use them in both the base and inspect entries.

- [ ] **Step 4: Fix typecheck fallout.** `pnpm typecheck`. `Record<PermissionProfile, …>` consumers (e.g. `POSTING_PROFILES`, any exhaustive map) need the two new profiles treated as non-posting. Do not change posting behaviour.

- [ ] **Step 5: Update the two existing full-table pins.**
  - `toEqual(DEFAULT_PERMISSIONS)` at ~line 100: add `'development:inspect'` and `'investigation:development:inspect'` with the exact deny arrays (base array + `'Bash(git commit:*)', 'Bash(git push:*)'`).
  - The `(mode, intent)` → profile pin (~line 673) uses no stage, so its expected values stay identical — leave unchanged; that is the proof an unstaged caller behaves as today.

- [ ] **Step 6: Run.** `pnpm vitest run test/workspace/permission-guard.test.ts` and `pnpm typecheck` → PASS.

- [ ] **Step 7: Commit.**

```bash
git add cgremlin/core/src/workspace cgremlin/core/test/workspace
git commit -m "feat(cgremlin-core): PermissionSubject.stage; review/live-check stages in a dev worktree cannot commit or push"
```

---

### Task 3: Pass the stage from the stage runner

**Files:**
- Modify: `cgremlin/core/src/pipeline/stage-runner.ts:232-243` (the single `refreshWorkspaceGuardrails` call)
- Test: `cgremlin/core/test/pipeline/stage-runner.workspace-refresh.test.ts`

**Interfaces:**
- Consumes: `PermissionSubject.stage` (Task 2); the local `stage: StageName` in the stage runner.
- Produces: the settings file written before every run reflects `(session, stage)`.

- [ ] **Step 1: Write the failing test** in `stage-runner.workspace-refresh.test.ts`, following that file's existing helpers (`makeSession`, `STALE_REVIEW_SETTINGS`, the harness that runs a stage and reads `/w/<id>/.claude/settings.local.json`). Two cases:
  1. A `development`-mode session whose worktree holds the old permissive settings runs stage `review` → afterwards the written deny list contains `Bash(git commit:*)`, `Bash(git push:*)`, `Bash(gh pr ready:*)`, `Bash(gh api:*)` (also pins Review Focus 4: stale table replaced).
  2. The same session runs stage `develop` → deny contains `Bash(gh pr ready:*)` and `Bash(gh api:*)` but NOT `Bash(git commit:*)`/`Bash(git push:*)`.
  If the harness cannot run a `review` stage on a `development` session, drive `StageRunner.run` directly with `stage: 'review'` and a stub runner, as the file's other tests do.

- [ ] **Step 2: Run to verify failure.** `pnpm vitest run test/pipeline/stage-runner.workspace-refresh.test.ts` → case 1 FAIL (commit not denied).

- [ ] **Step 3: Implement.** Change the third argument of the call to `{ ...session, stage }` and extend the existing comment: "…and the STAGE, so a review or live-check run in a dev worktree is denied commit and push (R92)." Keep it the only call site (the structural test in this file must stay green). `pipeline-service.ts:1381` (conversation claim/release) deliberately passes no stage — leave it.

- [ ] **Step 4: Run.** `pnpm vitest run test/pipeline/stage-runner.workspace-refresh.test.ts` → PASS; then `pnpm test` in `cgremlin/core` → PASS (full suite, incl. both 0c preflight files).

- [ ] **Step 5: Commit.**

```bash
git add cgremlin/core/src/pipeline/stage-runner.ts cgremlin/core/test/pipeline/stage-runner.workspace-refresh.test.ts
git commit -m "feat(cgremlin-core): stage runner passes the stage to the guard refresh"
```

---

### Task 4: Header comment, brief wording, DECISIONS, full gates

**Files:**
- Modify: `cgremlin/core/src/workspace/permission-guard.ts` (header + `PermissionSubject` doc already done; update the `investigation:development` comment's "`development` below" references if any)
- Modify: `cgremlin/core/src/pipeline/prompts.ts` (`renderSessionAuthority`, ~line 505-540) **only if** it states what `development`/inspect stages may do; wording must match the table
- Modify: `cgremlin/core/docs/DECISIONS.md` (append a dated section)
- Test: `cgremlin/core/test/pipeline/prompts*.test.ts` only if the brief wording changes

- [ ] **Step 1: Update the guard header.** In the top block comment of `permission-guard.ts`, add one paragraph: profiles are now keyed on (mode, intent, conversation, stage); stage only narrows the two dev-landing profiles (commit/push off for inspect stages); it is as much a guardrail as everything else here.

- [ ] **Step 2: Check the brief.** `grep -n "development" cgremlin/core/src/pipeline/prompts.ts | sed -n 1,40p`. If any text promises a development session `gh pr ready`, `gh pr edit`, `gh api` or force-push, correct it and add/adjust a prompt test. If nothing does, leave prompts untouched.

- [ ] **Step 3: DECISIONS.** Append to `cgremlin/core/docs/DECISIONS.md`:

```markdown
## 2026-10-06 — Step 1 (development guard; stage-aware profiles, R92/R112)

- **`development` is hardened.** It used to deny only posting plus `gh pr merge`/`close`; a dev
  session could run `gh pr ready`, `gh pr edit`, `gh api` and force-push. It now denies
  `gh pr ready/edit/merge/close`, `gh api:*` and every force-push spelling (`--force`, `-f`,
  `+refspec`, and `--force-with-lease` until a later step needs it). Commit, push of its own
  branch and `gh pr create --draft` stay (the engine re-checks `isDraft`). The rest of the `gh`
  surface is unchanged on purpose.
- **Authority now depends on the stage too.** `PermissionSubject` gains `stage`;
  `development:inspect` and `investigation:development:inspect` are the two dev-landing profiles
  plus `git commit`/`git push` denies, selected for `review`, `rereview`, `phase_review` and
  `live_check`, so a stage that only looks at a dev worktree cannot change its branch. The stage
  runner passes it on its pre-run guard refresh; respond, QA, review and `review:conversation`
  resolve exactly as before.
- **Still a guardrail.** Same limits as the guard header: quoting and `git -C` defeat matching,
  MCP is not covered; non-draft `gh pr create` is still allowed to development (the engine checks
  `isDraft`, the brief says draft only).
```

- [ ] **Step 4: Full gates.** In `cgremlin/core`: `pnpm test && pnpm typecheck && pnpm lint`. In `cgremlin/vscode`: `pnpm test && pnpm typecheck && pnpm lint`. All PASS.

- [ ] **Step 5: Confirm 0c is intact.** `git diff mission-control-pr-orchestrator --stat -- cgremlin/core/src/pipeline/preflight.ts cgremlin/core/test/pipeline/preflight.test.ts cgremlin/core/test/pipeline/pipeline-service.preflight.test.ts` → empty output.

- [ ] **Step 6: Commit.**

```bash
git add cgremlin/core
git commit -m "docs(cgremlin-core): guard header and DECISIONS for step 1"
```

---

## After the tasks (not implementer work — run by the main session / chore agents)

1. Fresh-context whole-branch review of `step/1` (Review pipeline; Review Focus above + the program's five cross-cutting items). Fix CONFIRMED findings, re-run gates.
2. Release per `RELEASES.md`:
   - `git tag -a cgremlin-pre-1 8374d87 -m "installed before step 1 (0c)"`
   - Merge `step/1` into `mission-control-pr-orchestrator` (from the main checkout), then `git tag -a cgremlin-1 HEAD -m "step 1: development guard hardened; stage-aware profiles"`.
   - `cd cgremlin/vscode && pnpm build && pnpm package`; `code --install-extension cgremlin-vscode-0.0.1.vsix --force`; copy to `~/cgremlin-releases/cgremlin-vscode-0.0.1-1-built-2026-10-06.vsix` (check the exact version in `package.json`); refresh `~/cgremlin-releases/README.md`.
   - Add the `RELEASES.md` row (Date 2026-10-06 | `cgremlin-1` | merge commit | saved build | what changed | roll back to `cgremlin-0c`).
   - Update the program tracker (step 1 → `✅ done 2026-10-06`, detailed plan = this file, release tag `cgremlin-1`, and step 2 status if it depended on 1) and add a log row.
   - Push **only after the user confirms**: `git push origin mission-control-pr-orchestrator refs/tags/cgremlin-pre-1 refs/tags/cgremlin-1`.
3. `git worktree remove .claude/worktrees/1` and delete the merged `step/1` branch once merged.
