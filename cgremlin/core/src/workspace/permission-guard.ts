import type { SessionFileSystem } from '../fs/session-file-system';
import type { SessionMode } from '../schema/session-mode';

export interface PermissionConfig {
  allow?: string[];
  deny?: string[];
}

/**
 * Phase 20 — posting is allowed for `review` and `respond`, and nothing more.
 * `gh pr review` cannot attach a comment at a file:line, so the review itself
 * is submitted through the REST reviews endpoint, which carries the inline
 * `comments` array; the pulls comments endpoint is what an agent reads to see
 * what it already posted (and, for respond, where a threaded reply goes).
 */
const POSTING_ALLOW = [
  'Bash(gh pr review:*)',
  'Bash(gh pr comment:*)',
  'Bash(gh api:*/pulls/*/reviews*)',
  'Bash(gh api:*/pulls/*/comments*)',
] as const;

/** Changing or landing the PR is not posting — denied in every mode. */
const NEVER_LAND = [
  'Bash(gh pr merge:*)',
  'Bash(gh pr close:*)',
  'Bash(gh pr edit:*)',
  'Bash(gh pr ready:*)',
] as const;

/**
 * The blanket `gh api --method` deny cannot stay where POST must get through,
 * so the verbs that MUTATE an existing PR (merge is PUT, close/edit are PATCH)
 * are denied by name instead, in both spellings `gh api` accepts. GraphQL stays
 * denied outright: it is a second door to the same mutations.
 */
const API_WRITE_DENY = [
  'Bash(gh api:*--method PUT*)',
  'Bash(gh api:*--method PATCH*)',
  'Bash(gh api:*--method DELETE*)',
  'Bash(gh api:*-X PUT*)',
  'Bash(gh api:*-X PATCH*)',
  'Bash(gh api:*-X DELETE*)',
  'Bash(gh api:*graphql*)',
] as const;

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
  // comment; it may never LAND or rewrite the PR, and it may never force-push
  // the branch it is allowed to push.
  //
  // SCOPE, stated plainly: this pattern language is a prefix/glob match with
  // no negation, so it CANNOT express "only PR #N of repo X". Under
  // `--permission-mode bypassPermissions` (how the engine runs agents) an
  // allow entry is inert anyway — only `deny` bites. The allow list below is
  // therefore a statement of intent, and the "post to this PR and no other"
  // rule is carried by the brief, which is the only place that knows the
  // session's repo and number.
  respond: {
    allow: [...POSTING_ALLOW],
    deny: [...NEVER_LAND, ...API_WRITE_DENY, 'Bash(git push --force:*)', 'Bash(git push -f:*)'],
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
  // Phase 20 — the review agent posts its own review (see `respond` above for
  // why the scoping lives in the brief). It still writes no code: no commit,
  // no push, and no `gh pr create`.
  review: {
    allow: [...POSTING_ALLOW],
    deny: [
      ...NEVER_LAND,
      'Bash(gh pr create:*)',
      ...API_WRITE_DENY,
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
