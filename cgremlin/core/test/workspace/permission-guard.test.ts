import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PERMISSIONS,
  permissionProfileFor,
  renderPermissionSettings,
  writePermissionSettings,
  type PermissionSubject,
} from '../../src/workspace/permission-guard';
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
  it('writes the investigation deny-list to .claude/settings.local.json — an investigation posts nothing', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/work/inv-1', { recursive: true });
    await writePermissionSettings(fs, '/work/inv-1', { mode: 'investigation' });
    const content = await fs.readFile('/work/inv-1/.claude/settings.local.json');
    const parsed = JSON.parse(content);
    expect(parsed.permissions.deny).toContain('Bash(gh pr comment:*)');
    expect(parsed.permissions.allow).toBeUndefined();
  });

  it('writes the review mode deny-list to .claude/settings.local.json', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/work/pr-1', { recursive: true });
    await writePermissionSettings(fs, '/work/pr-1', { mode: 'review' });
    const content = await fs.readFile('/work/pr-1/.claude/settings.local.json');
    const parsed = JSON.parse(content);
    expect(parsed.permissions.deny).toContain('Bash(git push:*)');
  });

  it('writes the development mode deny-list (GitHub PR mutations) to .claude/settings.local.json', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/work/dev-1', { recursive: true });
    await writePermissionSettings(fs, '/work/dev-1', { mode: 'development' });
    const content = await fs.readFile('/work/dev-1/.claude/settings.local.json');
    const parsed = JSON.parse(content);
    expect(parsed.permissions.deny).toContain('Bash(gh pr review:*)');
  });
});

describe('permission guards without dead cgremlin callbacks (phase 3a)', () => {
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
});

/**
 * Phase 20 — the review and respond agents post to GitHub themselves, but
 * never through a bare `gh` write verb. `gh` honours `-R/--repo`, so an
 * unscoped `gh pr comment` reaches EVERY pull request the token can see, and
 * the material an agent is reading (a PR diff, a review thread) is written by
 * whoever opened the PR. A prefix/glob deny cannot say "this one PR only", so
 * the verbs are denied outright in every mode and the one legitimate write is
 * carried by a helper with the repo and number compiled into it.
 *
 * Agents run under `--permission-mode bypassPermissions`, so `allow` entries
 * are INERT and only `deny` bites. This table IS the policy; it is pinned by
 * value so the guard cannot drift without this file changing too.
 */
const NEVER_POST = [
  'Bash(gh pr review:*)',
  'Bash(gh pr comment:*)',
  // Round 3 — a PR shares the issue-comment endpoint, so this posts to one too.
  'Bash(gh issue:*)',
] as const;
const NEVER_LAND = [
  'Bash(gh pr merge:*)',
  'Bash(gh pr close:*)',
  'Bash(gh pr edit:*)',
  'Bash(gh pr ready:*)',
] as const;
const ALL_MODES = ['investigation', 'development', 'respond', 'qa', 'review'] as const;
const POSTING_MODES = ['review', 'respond'] as const;

describe('phase 20 — the per-mode deny table', () => {
  it('is exactly this, for every profile, and nothing else', () => {
    expect(DEFAULT_PERMISSIONS).toEqual({
      investigation: {
        deny: [
          'Bash(gh pr review:*)',
          'Bash(gh pr comment:*)',
          'Bash(gh issue:*)',
          'Bash(gh pr merge:*)',
          'Bash(gh pr close:*)',
          'Bash(gh pr edit:*)',
          'Bash(gh pr create:*)',
          'Bash(gh pr ready:*)',
          'Bash(gh api:*)',
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
          'Bash(git push:*)',
          'Bash(git commit:*)',
        ],
      },
      'investigation:development': {
        deny: [
          'Bash(gh pr review:*)',
          'Bash(gh pr comment:*)',
          'Bash(gh issue:*)',
          'Bash(gh pr merge:*)',
          'Bash(gh pr close:*)',
        ],
      },
      development: {
        deny: [
          'Bash(gh pr review:*)',
          'Bash(gh pr comment:*)',
          'Bash(gh issue:*)',
          'Bash(gh pr merge:*)',
          'Bash(gh pr close:*)',
        ],
      },
      respond: {
        deny: [
          'Bash(gh pr review:*)',
          'Bash(gh pr comment:*)',
          'Bash(gh issue:*)',
          'Bash(gh pr merge:*)',
          'Bash(gh pr close:*)',
          'Bash(gh pr edit:*)',
          'Bash(gh pr ready:*)',
          'Bash(gh pr create:*)',
          'Bash(gh api:*)',
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
          'Bash(git push --force:*)',
          'Bash(git push -f:*)',
          'Bash(git push --force-with-lease:*)',
          'Bash(git push --force-with-lease=*)',
          'Bash(git push * --force)',
          'Bash(git push * --force *)',
          'Bash(git push * -f)',
          'Bash(git push * -f *)',
          'Bash(git push * --force-with-lease)',
          'Bash(git push * --force-with-lease *)',
          'Bash(git push * --force-with-lease=*)',
          'Bash(git push * +*)',
        ],
      },
      qa: {
        deny: [
          'Bash(gh pr review:*)',
          'Bash(gh pr comment:*)',
          'Bash(gh issue:*)',
          'Bash(gh pr merge:*)',
          'Bash(gh pr close:*)',
          'Bash(gh pr edit:*)',
          'Bash(gh pr create:*)',
          'Bash(gh pr ready:*)',
          'Bash(gh api:*)',
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
          'Bash(git push:*)',
          'Bash(git commit:*)',
        ],
      },
      review: {
        deny: [
          'Bash(gh pr review:*)',
          'Bash(gh pr comment:*)',
          'Bash(gh issue:*)',
          'Bash(gh pr merge:*)',
          'Bash(gh pr close:*)',
          'Bash(gh pr edit:*)',
          'Bash(gh pr ready:*)',
          'Bash(gh pr create:*)',
          'Bash(gh api:*)',
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
          'Bash(git push:*)',
          'Bash(git commit:*)',
        ],
      },
    });
  });

  it.each(ALL_MODES)('%s grants no allow entry — allow is inert under bypassPermissions', (mode) => {
    expect(DEFAULT_PERMISSIONS[mode].allow).toBeUndefined();
  });
});

describe('phase 20 — no mode may run an unscoped GitHub write verb', () => {
  it.each(POSTING_MODES)('%s denies gh pr review and gh pr comment, scoping is the helper’s job', (mode) => {
    expect(DEFAULT_PERMISSIONS[mode].deny ?? []).toEqual(expect.arrayContaining([...NEVER_POST]));
  });

  it.each(POSTING_MODES)('%s denies `gh api` outright — it is not a posting verb', (mode) => {
    expect(DEFAULT_PERMISSIONS[mode].deny ?? []).toContain('Bash(gh api:*)');
  });

  it.each(POSTING_MODES)('%s denies merge, close, edit and ready outright', (mode) => {
    expect(DEFAULT_PERMISSIONS[mode].deny ?? []).toEqual(expect.arrayContaining([...NEVER_LAND]));
  });

  it('respond may push its own branch but never force-push it', () => {
    const deny = DEFAULT_PERMISSIONS.respond.deny ?? [];
    expect(deny).toContain('Bash(git push --force:*)');
    expect(deny).toContain('Bash(git push -f:*)');
    expect(deny).not.toContain('Bash(git push:*)');
  });

  it('review still commits nothing and pushes nothing', () => {
    const deny = DEFAULT_PERMISSIONS.review.deny ?? [];
    expect(deny).toContain('Bash(git push:*)');
    expect(deny).toContain('Bash(git commit:*)');
  });
});

/**
 * An investigation writes findings into its session directory. It posts
 * nothing and it lands nothing — and under `bypassPermissions` an empty
 * config denied nothing, so every one of those had been available.
 */
describe('phase 20 — investigation writes findings and nothing else', () => {
  it.each([
    'Bash(gh pr review:*)',
    'Bash(gh pr comment:*)',
    'Bash(gh pr merge:*)',
    'Bash(gh pr close:*)',
    'Bash(gh pr edit:*)',
    'Bash(gh pr create:*)',
    'Bash(gh pr ready:*)',
    'Bash(gh issue:*)',
    'Bash(gh api:*)',
    'Bash(git push:*)',
    'Bash(git commit:*)',
  ])('denies %s', (rule) => {
    expect(DEFAULT_PERMISSIONS.investigation.deny ?? []).toContain(rule);
  });
});

/**
 * `Bash(gh api:*--method*)` and `Bash(gh api:*graphql*)` never covered
 * `gh api -X POST /repos/...` — the short form of `--method` — so QA's API
 * ban had a hole the posting modes did not. QA uses the same outright deny.
 */
describe('phase 20 — qa denies `gh api` outright, short flag included', () => {
  it('denies every `gh api` invocation, not just the two spellings it used to name', () => {
    const deny = DEFAULT_PERMISSIONS.qa.deny ?? [];
    expect(deny).toContain('Bash(gh api:*)');
    expect(deny).not.toContain('Bash(gh api:*--method*)');
    expect(deny).not.toContain('Bash(gh api:*graphql*)');
  });

  it.each(['investigation', 'respond', 'qa', 'review'] as const)(
    '%s bans `gh api` with the one rule every other non-development mode uses',
    (mode) => {
      expect(DEFAULT_PERMISSIONS[mode].deny ?? []).toContain('Bash(gh api:*)');
    },
  );
});

/**
 * The deny patterns are matched by Claude Code's documented Bash-rule matcher
 * (code.claude.com/docs/en/permissions.md, "Wildcard patterns"): the rule is
 * matched against the whole command text, `*` stands in for any text, a
 * trailing ` *` ALSO matches the bare command but only when it is the rule's
 * only wildcard, and `:*` is exactly that trailing ` *`. Reimplemented here so
 * the table is proved against COMMANDS AS TYPED, not against its own strings —
 * `Bash(git push --force:*)` looks like it bans force-pushing and does not.
 */
const matchesRule = (rule: string, command: string): boolean => {
  const body = rule.replace(/^Bash\((.*)\)$/s, '$1');
  const glob = body.endsWith(':*') ? `${body.slice(0, -2)} *` : body;
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`^${glob.split('*').map(escape).join('.*')}$`).test(command)) return true;
  const onlyWildcardIsTrailing = glob.endsWith(' *') && glob.indexOf('*') === glob.length - 1;
  return onlyWildcardIsTrailing && command === glob.slice(0, -2);
};

const isDenied = (mode: (typeof ALL_MODES)[number], command: string): boolean =>
  (DEFAULT_PERMISSIONS[mode].deny ?? []).some((rule) => matchesRule(rule, command));

describe('the respond force-push ban covers the spellings people actually type', () => {
  it.each([
    'git push --force',
    'git push -f',
    'git push --force origin my-branch',
    'git push -f origin my-branch',
    'git push origin my-branch --force',
    'git push origin my-branch -f',
    'git push --force-with-lease',
    'git push --force-with-lease origin my-branch',
    'git push origin my-branch --force-with-lease',
    'git push --force-with-lease=refs/heads/my-branch:0ff1ce origin my-branch',
    'git push origin my-branch --force-with-lease=refs/heads/my-branch:0ff1ce',
    'git push origin +my-branch',
    'git push origin +HEAD:my-branch',
  ])('denies `%s`', (command) => {
    expect(isDenied('respond', command)).toBe(true);
  });

  it.each(['git push', 'git push -u origin HEAD', 'git push origin my-branch'])(
    'still lets respond push its own branch: `%s`',
    (command) => {
      expect(isDenied('respond', command)).toBe(false);
    },
  );
});

/**
 * Every other non-development mode denies `gh pr create`. respond did not, so
 * a respond agent — reading review threads written by other people — could
 * open an unrelated pull request. It has nothing to open one for: the PR it
 * answers on already exists.
 */
describe('respond opens no pull request of its own', () => {
  it('denies `gh pr create`, like every other non-development mode', () => {
    expect(DEFAULT_PERMISSIONS.respond.deny ?? []).toContain('Bash(gh pr create:*)');
  });

  it.each(['investigation', 'respond', 'qa', 'review'] as const)('%s denies it', (mode) => {
    expect(isDenied(mode, 'gh pr create --draft --title x')).toBe(true);
  });

  it('development still opens its own draft PR', () => {
    expect(isDenied('development', 'gh pr create --draft --title x')).toBe(false);
  });
});

/**
 * `gh` is far more than `pr`, `issue` and `api`. Under `bypassPermissions`
 * everything not named here ran unobstructed, which meant a review agent —
 * reading a diff written by someone else — could take the repository private,
 * drop a branch-protection ruleset, write an Actions secret, dispatch a
 * workflow, cut a release, or install an extension. None of that is anyone's
 * job in any of these four modes.
 */
const ADMINISTRATIVE_GH = [
  'gh repo edit --visibility public',
  'gh ruleset delete 42',
  'gh secret set NPM_TOKEN --body x',
  'gh variable set FOO --body x',
  'gh workflow run deploy.yml',
  'gh release create v9.9.9',
  'gh gist create secrets.txt',
  'gh label delete bug',
  'gh cache delete --all',
  'gh alias set x "pr merge"',
  'gh extension install owner/evil',
  'gh codespace create -r owner/repo',
  'gh ssh-key add ~/.ssh/id_ed25519.pub',
  'gh gpg-key add key.asc',
  'gh auth login --with-token',
  'gh auth logout',
  'gh auth refresh -s admin:org',
  'gh auth setup-git',
  'gh auth switch -u someone',
] as const;
const GUARDED_MODES = ['investigation', 'qa', 'review', 'respond'] as const;

describe('the administrative `gh` surface outside pr/issue/api', () => {
  it.each(GUARDED_MODES)('%s denies every one of them', (mode) => {
    for (const command of ADMINISTRATIVE_GH) {
      expect([command, isDenied(mode, command)]).toEqual([command, true]);
    }
  });

  it.each(GUARDED_MODES)('%s keeps `gh auth token` reachable — both helpers need it', (mode) => {
    expect(isDenied(mode, 'gh auth token')).toBe(false);
  });

  it('development is untouched by this phase and keeps the whole surface', () => {
    for (const command of ADMINISTRATIVE_GH) {
      expect([command, isDenied('development', command)]).toEqual([command, false]);
    }
  });
});

/**
 * Round 3 pre-merge — `gh issue comment <number>` posts to a PULL REQUEST.
 *
 * Pull requests and issues share the issue-comment endpoint, so `gh issue comment 2140 -b …`
 * lands a comment on PR 2140. `NEVER_POST` named `gh pr review` and `gh pr comment` and stopped
 * there, which left the "no mode may type a bare GitHub write verb" property with an unlisted
 * bypass in the two modes that actually talk to GitHub. Investigation and QA already denied it
 * through `WRITES_NOTHING_OUTWARD`; it belongs in the shared list, where no mode can miss it.
 */
describe('round 3 — no mode may reach a pull request through `gh issue`', () => {
  it.each(ALL_MODES)('denies `gh issue` in %s', (mode) => {
    expect(DEFAULT_PERMISSIONS[mode].deny ?? []).toContain('Bash(gh issue:*)');
  });

  it('names it once per mode, not twice — the shared list is the only source', () => {
    for (const mode of ALL_MODES) {
      const deny = DEFAULT_PERMISSIONS[mode].deny ?? [];
      expect(deny.filter((rule) => rule === 'Bash(gh issue:*)'), mode).toHaveLength(1);
    }
  });
});

/**
 * The regression this file exists to pin. A session whose `intent` is
 * `development` is not "an investigation that posts nothing": it is the
 * session the human keeps working in, and `promote()` hands the development
 * session this very worktree and branch. Keying the table on `mode` alone
 * denied it `git commit`, `git push` and `gh pr create`, so an agent that had
 * finished the whole job could not land any of it — and Claude Code's
 * self-modification guard correctly stopped it from editing the file that
 * blocked it.
 *
 * The fixture is shaped like the real session this was found on:
 * `mode: investigation`, `intent: development`, `stageStatus: plan_ready`.
 */
const DEVELOPMENT_BOUND_INVESTIGATION = {
  mode: 'investigation',
  intent: 'development',
  stageStatus: 'plan_ready',
} as const;
const PLAIN_INVESTIGATION = {
  mode: 'investigation',
  intent: 'investigate_only',
  stageStatus: 'plan_ready',
} as const;

async function denyListFor(subject: PermissionSubject): Promise<string[]> {
  const fs = new InMemoryFileSystem();
  await fs.mkdir('/work/s', { recursive: true });
  await writePermissionSettings(fs, '/work/s', subject);
  const parsed = JSON.parse(await fs.readFile('/work/s/.claude/settings.local.json'));
  return parsed.permissions.deny ?? [];
}

describe('a session with intent=development may land its own work', () => {
  const LANDING = ['Bash(git commit:*)', 'Bash(git push:*)', 'Bash(gh pr create:*)'] as const;

  it.each(LANDING)('does not deny %s for a development-bound investigation', async (rule) => {
    expect(await denyListFor(DEVELOPMENT_BOUND_INVESTIGATION)).not.toContain(rule);
  });

  it.each(LANDING)('still denies %s for an investigation with no development intent', async (rule) => {
    expect(await denyListFor(PLAIN_INVESTIGATION)).toContain(rule);
  });

  it('an investigation with no intent field at all is treated as investigate-only', async () => {
    expect(await denyListFor({ mode: 'investigation' })).toEqual(
      DEFAULT_PERMISSIONS.investigation.deny,
    );
  });

  it('intent never widens a mode that is not an investigation', () => {
    for (const mode of ['development', 'respond', 'qa', 'review'] as const) {
      expect(permissionProfileFor({ mode, intent: 'development' })).toBe(mode);
    }
  });
});
