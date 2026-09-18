import type { SessionFileSystem } from '../fs/session-file-system';
import type { SessionMode } from '../schema/session-mode';

export interface PermissionConfig {
  allow?: string[];
  deny?: string[];
}

/**
 * Phase 20 — `gh pr review` and `gh pr comment` are the ONLY GitHub write
 * verbs an agent runs itself. A review with inline comments needs the REST
 * reviews endpoint, which `gh pr review` cannot reach; that call is made by
 * the scoped `.cgremlin/post-review` helper the engine writes into the
 * worktree (see ./post-review-helper.ts), NOT by the agent typing `gh api`.
 *
 * WHY THE SCOPING CANNOT LIVE HERE: the engine runs agents with
 * `--permission-mode bypassPermissions` (src/agent/claude-code-runner.ts:40),
 * so every `allow` entry below is INERT — only `deny` bites. And the pattern
 * language is a prefix/glob match with no negation, so a deny can never say
 * "every repo and number except this one". A rule scoped to one PR is
 * therefore unexpressible here; it is expressed by baking the repo slug and
 * the PR number into the helper at write time.
 */
const POSTING_ALLOW = ['Bash(gh pr review:*)', 'Bash(gh pr comment:*)'] as const;

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
 * helper carries the one POST an agent legitimately needs.
 */
const GH_API_DENY = 'Bash(gh api:*)';

export const DEFAULT_PERMISSIONS: Record<SessionMode, PermissionConfig> = {
  investigation: {},
  development: {
    deny: [
      'Bash(gh pr review:*)',
      'Bash(gh pr comment:*)',
      'Bash(gh pr merge:*)',
      'Bash(gh pr close:*)',
    ],
  },
  // Phase 20 — the deferred-posting decision was reversed by the user: the
  // respond agent replies on its OWN pull request itself. It may reply and
  // comment; it may never LAND or rewrite the PR, may never call `gh api`,
  // and may never force-push the branch it is allowed to push. The one REST
  // call it needs is made for it by `.cgremlin/post-review`, which has this
  // session's repo and number baked in (see the header comment for why that
  // scoping cannot be expressed as a pattern).
  respond: {
    allow: [...POSTING_ALLOW],
    deny: [...NEVER_LAND, GH_API_DENY, 'Bash(git push --force:*)', 'Bash(git push -f:*)'],
  },
  // R68/§9 — QA writes nothing outward: no PR, no issue, no mutating API
  // call. Phase 20 did NOT touch it (nor development, nor investigation). It
  // used to be defined as "review's deny list plus more"; review now
  // deliberately permits posting, so QA's list is spelled out in full here.
  // NOTE (stated plainly, per §9): this guard covers `Bash(...)` only — an MCP
  // server exposing a write tool is NOT blocked by settings.local.json. The
  // brief and the skill carry the prohibition for everything the guard cannot
  // reach.
  qa: {
    deny: [
      'Bash(gh pr review:*)',
      'Bash(gh pr comment:*)',
      'Bash(gh pr merge:*)',
      'Bash(gh pr close:*)',
      'Bash(gh pr edit:*)',
      'Bash(gh pr create:*)',
      'Bash(gh pr ready:*)',
      'Bash(gh issue:*)',
      'Bash(gh api:*--method*)',
      'Bash(gh api:*graphql*)',
      'Bash(git push:*)',
      'Bash(git commit:*)',
    ],
  },
  // Phase 20 — the review agent posts its own review, through
  // `.cgremlin/post-review` for the review itself and `gh pr comment` for a
  // plain conversation comment. It still writes no code: no commit, no push,
  // no `gh pr create` — and no `gh api`.
  review: {
    allow: [...POSTING_ALLOW],
    deny: [
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
