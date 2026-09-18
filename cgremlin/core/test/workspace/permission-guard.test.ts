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
 * Phase 20 — the user reversed the deferred-posting decision: the review and
 * respond agents now post to GitHub themselves. This table IS the policy, and
 * it is pinned here so the guard cannot drift without this file changing too.
 * Changing or LANDING the PR is still not posting: merge/close/edit/ready stay
 * denied everywhere, in every mode.
 */
const POSTING_VERBS = ['Bash(gh pr review:*)', 'Bash(gh pr comment:*)'] as const;
const NEVER_ALLOWED = [
  'Bash(gh pr merge:*)',
  'Bash(gh pr close:*)',
  'Bash(gh pr edit:*)',
  'Bash(gh pr ready:*)',
] as const;
const POSTING_MODES = ['review', 'respond'] as const;

describe('phase 20 — review and respond post to GitHub themselves', () => {
  it.each(POSTING_MODES)('%s allows gh pr review and gh pr comment', (mode) => {
    const cfg = DEFAULT_PERMISSIONS[mode];
    for (const verb of POSTING_VERBS) {
      expect(cfg.deny ?? []).not.toContain(verb);
      expect(cfg.allow ?? []).toContain(verb);
    }
  });

  it.each(POSTING_MODES)('%s allows the REST POST that carries inline comments, but no mutating verb beyond it', (mode) => {
    const cfg = DEFAULT_PERMISSIONS[mode];
    expect(cfg.allow ?? []).toContain('Bash(gh api:*/pulls/*/reviews*)');
    expect(cfg.allow ?? []).toContain('Bash(gh api:*/pulls/*/comments*)');
    for (const rule of [
      'Bash(gh api:*--method PUT*)',
      'Bash(gh api:*--method PATCH*)',
      'Bash(gh api:*--method DELETE*)',
      'Bash(gh api:*-X PUT*)',
      'Bash(gh api:*-X PATCH*)',
      'Bash(gh api:*-X DELETE*)',
      'Bash(gh api:*graphql*)',
    ]) {
      expect(cfg.deny ?? []).toContain(rule);
    }
  });

  it.each(['investigation', 'development', 'respond', 'qa', 'review'] as const)(
    '%s never gets to land or rewrite a PR',
    (mode) => {
      const allow = DEFAULT_PERMISSIONS[mode].allow ?? [];
      for (const rule of NEVER_ALLOWED) expect(allow).not.toContain(rule);
    },
  );

  it.each(POSTING_MODES)('%s denies merge, close, edit and ready outright', (mode) => {
    expect(DEFAULT_PERMISSIONS[mode].deny ?? []).toEqual(expect.arrayContaining([...NEVER_ALLOWED]));
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

  it('qa and development are untouched by phase 20 — neither posts', () => {
    expect(DEFAULT_PERMISSIONS.development).toEqual({
      deny: [
        'Bash(gh pr review:*)',
        'Bash(gh pr comment:*)',
        'Bash(gh pr merge:*)',
        'Bash(gh pr close:*)',
      ],
    });
    expect(DEFAULT_PERMISSIONS.qa).toEqual({
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
    });
    expect(DEFAULT_PERMISSIONS.investigation).toEqual({});
  });
});
