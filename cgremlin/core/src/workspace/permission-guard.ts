import type { SessionFileSystem } from '../fs/session-file-system';
import type { SessionMode } from '../schema/session-mode';

export interface PermissionConfig {
  allow?: string[];
  deny?: string[];
}

/**
 * Phase 20 — NO mode may run a bare GitHub write verb. `gh pr review` and
 * `gh pr comment` both honour `-R/--repo`, so either one, unscoped, reaches
 * every pull request the token can see — and the material a review agent is
 * reading is written by whoever opened the PR. The verbs are therefore denied
 * everywhere; the two writes an agent legitimately makes are carried by the
 * scoped `.cgremlin/post-review` and `.cgremlin/post-comment` helpers the
 * engine writes into the worktree (see ./post-helpers.ts).
 *
 * WHY THE SCOPING CANNOT LIVE HERE: the engine runs agents with
 * `--permission-mode bypassPermissions` (src/agent/claude-code-runner.ts:40),
 * so an `allow` entry would be INERT — only `deny` bites, and anything not
 * denied is already available. And the pattern language is a prefix/glob
 * match with no negation, so a rule can never say "every repo and number
 * except this one". A rule scoped to one PR is unexpressible here; it is
 * expressed by baking the repo slug and the PR number into the helpers at
 * write time. Nothing below grants anything — this table only takes away.
 */
const NEVER_POST = ['Bash(gh pr review:*)', 'Bash(gh pr comment:*)'] as const;

/** Changing or landing the PR is not posting — denied in every mode. */
const NEVER_LAND = [
  'Bash(gh pr merge:*)',
  'Bash(gh pr close:*)',
  'Bash(gh pr edit:*)',
  'Bash(gh pr ready:*)',
] as const;

/**
 * `gh api` is denied OUTRIGHT for the posting modes. Splitting it by verb
 * (deny PUT/PATCH/DELETE, let POST through) left every POST endpoint open —
 * create an issue, cut a release, dispatch a workflow, POST /merges, write a
 * git ref — none of which is "review this PR". One rule, no exceptions; the
 * helpers carry the only two POSTs an agent legitimately needs.
 */
const GH_API_DENY = 'Bash(gh api:*)';

/**
 * A rule is matched against the WHOLE command text, `*` standing in for any
 * text; a trailing ` *` (which is all `:*` means) also matches the bare
 * command, but only when it is the rule's only wildcard. So
 * `Bash(git push --force:*)` catches `git push --force …` and nothing else:
 * `git push origin my-branch --force` and the old-style forced refspec
 * `git push origin +my-branch` both walked straight past it. Every spelling
 * therefore needs its own rule — the flag next to `git push`, the flag later
 * in the line with and without arguments after it, and the `+refspec`.
 *
 * STILL UNCOVERED, and not coverable by any rule shape here: a rule beginning
 * `git push` never sees `git -c push.default=current push --force` or
 * `git -C . push --force`, and quoting (`git 'push' --force`) defeats matching
 * outright. See the header — this is a guardrail, not a boundary.
 */
const NEVER_FORCE_PUSH = [
  // The flag immediately after `git push` (`:*` also matches the bare form).
  'Bash(git push --force:*)',
  'Bash(git push -f:*)',
  'Bash(git push --force-with-lease:*)',
  'Bash(git push --force-with-lease=*)',
  // The flag later in the line, as the last token and as a not-last token.
  'Bash(git push * --force)',
  'Bash(git push * --force *)',
  'Bash(git push * -f)',
  'Bash(git push * -f *)',
  'Bash(git push * --force-with-lease)',
  'Bash(git push * --force-with-lease *)',
  'Bash(git push * --force-with-lease=*)',
  // `git push origin +my-branch` — a force push with no flag on it at all.
  'Bash(git push * +*)',
] as const;

/**
 * An investigation, and QA, write nothing outward at all: no review, no
 * comment, no issue, no API call, nothing landed. Under `bypassPermissions`
 * an empty config denied NOTHING, so investigation used to have every one of
 * these available to it; the list is shared so the two cannot drift.
 */
const WRITES_NOTHING_OUTWARD = [
  ...NEVER_POST,
  'Bash(gh pr merge:*)',
  'Bash(gh pr close:*)',
  'Bash(gh pr edit:*)',
  'Bash(gh pr create:*)',
  'Bash(gh pr ready:*)',
  'Bash(gh issue:*)',
] as const;

export const DEFAULT_PERMISSIONS: Record<SessionMode, PermissionConfig> = {
  // An investigation writes findings into its session directory. That is all
  // it does: it posts nothing and it lands nothing.
  investigation: {
    deny: [...WRITES_NOTHING_OUTWARD, GH_API_DENY, 'Bash(git push:*)', 'Bash(git commit:*)'],
  },
  development: {
    deny: [
      ...NEVER_POST,
      'Bash(gh pr merge:*)',
      'Bash(gh pr close:*)',
    ],
  },
  // Phase 20 — the deferred-posting decision was reversed by the user: the
  // respond agent replies on its OWN pull request itself. It replies through
  // `.cgremlin/post-review` and `.cgremlin/post-comment`, which have this
  // session's repo and number baked in (see the header comment for why that
  // scoping cannot be expressed as a pattern); it may never type a `gh` write
  // verb itself, never LAND or rewrite the PR, never call `gh api`, and never
  // force-push the branch it is allowed to push.
  respond: {
    deny: [
      ...NEVER_POST,
      ...NEVER_LAND,
      GH_API_DENY,
      ...NEVER_FORCE_PUSH,
    ],
  },
  // R68/§9 — QA writes nothing outward: no PR, no issue, no API call at all.
  // It used to name `gh api:*--method*` and `gh api:*graphql*`, which left
  // `gh api -X POST /repos/...` — the short form — wide open; it uses the
  // outright ban now, like every other non-development mode. It used to be
  // defined as "review's deny list plus more"; the lists have since diverged,
  // so QA shares investigation's list instead.
  // NOTE (stated plainly, per §9): this guard covers `Bash(...)` only — an MCP
  // server exposing a write tool is NOT blocked by settings.local.json. The
  // brief and the skill carry the prohibition for everything the guard cannot
  // reach.
  qa: {
    deny: [
      ...WRITES_NOTHING_OUTWARD,
      GH_API_DENY,
      'Bash(git push:*)',
      'Bash(git commit:*)',
    ],
  },
  // Phase 20 — the review agent posts its own review, through
  // `.cgremlin/post-review` for the review itself and `.cgremlin/post-comment`
  // for a plain conversation comment. It types no `gh` write verb of its own,
  // and it still writes no code: no commit, no push, no `gh pr create` — and
  // no `gh api`.
  review: {
    deny: [
      ...NEVER_POST,
      ...NEVER_LAND,
      'Bash(gh pr create:*)',
      GH_API_DENY,
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
