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
