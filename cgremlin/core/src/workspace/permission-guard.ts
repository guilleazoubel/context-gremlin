import type { SessionFileSystem } from '../fs/session-file-system';
import type { SessionMode } from '../schema/session-mode';
import type { Intent } from '../schema/session';

/**
 * THIS TABLE IS A GUARDRAIL, NOT A SECURITY BOUNDARY. It binds a COOPERATIVE
 * agent and nothing else.
 *
 * A deny rule matches Bash command text. It does not wall off the network.
 * Nothing here denies `curl`, `wget`, `node -e` or `python3 -c`, and
 * `gh auth token` stays readable because the post helpers need it — so any
 * agent that wants to can read that token and POST to api.github.com against
 * every repository the token can reach. That is not a hole to be patched: it
 * is how the sanctioned helpers themselves post (./post-helpers.ts), and no
 * pattern in this language can close it. Quoting (`git 'push' --force`) and a
 * wrapper (`git -c … push`) defeat matching on their own, MCP tools are not
 * covered at all, and the runner launches with `--permission-mode
 * bypassPermissions` (../agent/claude-code-runner.ts), so only `deny` bites.
 *
 * What this table buys is that an agent does not stumble into a destructive
 * command, and that an INJECTED instruction ("run `gh pr comment -R other/repo
 * …`") fails closed instead of succeeding quietly. What actually holds the
 * line is the brief telling the agent, plainly, that posting anywhere but its
 * own pull request is out of bounds even where nothing stops it — and the
 * permissions of the token itself. Do not add a rule here and call a class of
 * behaviour prevented; say in the brief what the rule does and does not do.
 */
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
const NEVER_POST = [
  'Bash(gh pr review:*)',
  'Bash(gh pr comment:*)',
  // Round 3 — a pull request IS an issue to the issue-comment endpoint, so
  // `gh issue comment <pr number> -b …` posts to the PR. It honours `-R` too.
  // Naming only the two `gh pr` verbs left the property with an unlisted
  // bypass in exactly the modes that talk to GitHub; it is shared now, so no
  // mode can be added without it.
  'Bash(gh issue:*)',
] as const;

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
 * `gh` is far more than `pr`, `issue` and `api`, and everything this table did
 * not name ran unobstructed under `bypassPermissions`: `gh repo edit
 * --visibility public`, `gh ruleset delete` (branch protection), `gh secret
 * set`, `gh workflow run`, `gh release create`, `gh gist create`, `gh alias
 * set`, `gh extension install`. None of it is any of these modes' job.
 *
 * Whole subcommands rather than verbs: the reads they also cover (`gh repo
 * view`, `gh workflow list`) are ones an agent with the worktree checked out
 * and `gh pr view` does not need, and a verb list is a list of holes.
 * `gh auth` is the exception — `gh auth token` must stay reachable because
 * both post helpers read the token with it (see ./post-helpers.ts), and there
 * is NO negation in this language: an allow rule cannot carve an exception out
 * of a deny. So `gh auth` is denied verb by verb, and `token` and `status`
 * are simply not on the list.
 *
 * Deliberately still reachable, and named so nobody mistakes the omission for
 * coverage: `gh run rerun|cancel` (CI reads are a normal part of reviewing),
 * `gh project`, `gh config`, `gh search`, `gh browse`. See the header.
 */
const NEVER_ADMINISTER = [
  'Bash(gh repo:*)',
  'Bash(gh ruleset:*)',
  'Bash(gh secret:*)',
  'Bash(gh variable:*)',
  'Bash(gh workflow:*)',
  'Bash(gh release:*)',
  'Bash(gh gist:*)',
  'Bash(gh label:*)',
  'Bash(gh cache:*)',
  'Bash(gh alias:*)',
  'Bash(gh extension:*)',
  'Bash(gh codespace:*)',
  'Bash(gh ssh-key:*)',
  'Bash(gh gpg-key:*)',
  'Bash(gh auth login:*)',
  'Bash(gh auth logout:*)',
  'Bash(gh auth refresh:*)',
  'Bash(gh auth setup-git:*)',
  'Bash(gh auth switch:*)',
] as const;

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
] as const;

/**
 * WHAT THIS SESSION IS FOR — the one question the table below is keyed on.
 *
 * `mode` alone is the wrong fact. An investigation whose `intent` is
 * `development` is not a session that "writes findings and lands nothing": it
 * is the session the human keeps working in, and `promote()` hands the
 * development session this very worktree and branch. Keyed on mode alone, such
 * a session was denied `git commit`, `git push` and `gh pr create` — an agent
 * that had finished the whole job could not land any of it, and could not even
 * edit the file that blocked it (Claude Code guards its own settings).
 *
 * So the subject is the session, not its mode, and `permissionProfileFor` is
 * the ONLY place that answers "what is this session allowed to do". Add a new
 * fact that changes a session's authority there and nowhere else — a second
 * table keyed on a second fact is how this drifts again.
 */
export interface PermissionSubject {
  mode: SessionMode;
  /** Only an investigation carries one; absent is `investigate_only`. */
  intent?: Intent;
}

/**
 * A profile is a mode, except for the one case where the mode does not say
 * what the session is for. Deliberately NOT `development`: a development-bound
 * investigation gains only the ability to land ITS OWN work — reviewing,
 * commenting and administering stay denied to it (see the entry below).
 */
export type PermissionProfile = SessionMode | 'investigation:development';

export function permissionProfileFor(subject: PermissionSubject): PermissionProfile {
  if (subject.mode === 'investigation' && subject.intent === 'development') {
    return 'investigation:development';
  }
  return subject.mode;
}

export const DEFAULT_PERMISSIONS: Record<PermissionProfile, PermissionConfig> = {
  // An investigation writes findings into its session directory. That is all
  // it does: it posts nothing and it lands nothing.
  investigation: {
    deny: [
      ...WRITES_NOTHING_OUTWARD,
      GH_API_DENY,
      ...NEVER_ADMINISTER,
      'Bash(git push:*)',
      'Bash(git commit:*)',
    ],
  },
  // An investigation that is development-bound: it commits, pushes and opens
  // its own draft pull request, exactly as `development` does.
  'investigation:development': {
    deny: [
      ...NEVER_POST,
      'Bash(gh pr merge:*)',
      'Bash(gh pr close:*)',
    ],
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
  // verb itself, never LAND or rewrite the PR, never call `gh api`, never
  // open a pull request of its own (the one it answers on already exists),
  // and never force-push the branch it is allowed to push.
  respond: {
    deny: [
      ...NEVER_POST,
      ...NEVER_LAND,
      'Bash(gh pr create:*)',
      GH_API_DENY,
      ...NEVER_ADMINISTER,
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
      ...NEVER_ADMINISTER,
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
      ...NEVER_ADMINISTER,
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
  subject: PermissionSubject,
): Promise<void> {
  const dir = `${worktreePath}/.claude`;
  await fs.mkdir(dir, { recursive: true });
  const content = renderPermissionSettings(DEFAULT_PERMISSIONS[permissionProfileFor(subject)]);
  await fs.writeFile(`${dir}/settings.local.json`, content);
}
