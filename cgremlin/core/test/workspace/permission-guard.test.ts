import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PERMISSIONS,
  renderPermissionSettings,
  writePermissionSettings,
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
  it('writes empty permissions for investigation mode (no allow-list needed) to .claude/settings.local.json', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/work/inv-1', { recursive: true });
    await writePermissionSettings(fs, '/work/inv-1', 'investigation');
    const content = await fs.readFile('/work/inv-1/.claude/settings.local.json');
    const parsed = JSON.parse(content);
    expect(parsed).toEqual({ permissions: {} });
  });

  it('writes the review mode deny-list to .claude/settings.local.json', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/work/pr-1', { recursive: true });
    await writePermissionSettings(fs, '/work/pr-1', 'review');
    const content = await fs.readFile('/work/pr-1/.claude/settings.local.json');
    const parsed = JSON.parse(content);
    expect(parsed.permissions.deny).toContain('Bash(git push:*)');
  });

  it('writes the development mode deny-list (GitHub PR mutations) to .claude/settings.local.json', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/work/dev-1', { recursive: true });
    await writePermissionSettings(fs, '/work/dev-1', 'development');
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
const NEVER_POST = ['Bash(gh pr review:*)', 'Bash(gh pr comment:*)'] as const;
const NEVER_LAND = [
  'Bash(gh pr merge:*)',
  'Bash(gh pr close:*)',
  'Bash(gh pr edit:*)',
  'Bash(gh pr ready:*)',
] as const;
const ALL_MODES = ['investigation', 'development', 'respond', 'qa', 'review'] as const;
const POSTING_MODES = ['review', 'respond'] as const;

describe('phase 20 — the per-mode deny table', () => {
  it('is exactly this, for all five modes, and nothing else', () => {
    expect(DEFAULT_PERMISSIONS).toEqual({
      investigation: {},
      development: {
        deny: [
          'Bash(gh pr review:*)',
          'Bash(gh pr comment:*)',
          'Bash(gh pr merge:*)',
          'Bash(gh pr close:*)',
        ],
      },
      respond: {
        deny: [
          'Bash(gh pr review:*)',
          'Bash(gh pr comment:*)',
          'Bash(gh pr merge:*)',
          'Bash(gh pr close:*)',
          'Bash(gh pr edit:*)',
          'Bash(gh pr ready:*)',
          'Bash(gh api:*)',
          'Bash(git push --force:*)',
          'Bash(git push -f:*)',
        ],
      },
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
      review: {
        deny: [
          'Bash(gh pr review:*)',
          'Bash(gh pr comment:*)',
          'Bash(gh pr merge:*)',
          'Bash(gh pr close:*)',
          'Bash(gh pr edit:*)',
          'Bash(gh pr ready:*)',
          'Bash(gh pr create:*)',
          'Bash(gh api:*)',
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
