import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../../../plugin');

describe('cgremlin plugin manifest', () => {
  it('declares name cgremlin and a semver version', () => {
    const m = JSON.parse(readFileSync(resolve(root, '.claude-plugin/plugin.json'), 'utf8'));
    expect(m.name).toBe('cgremlin');
    expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof m.description).toBe('string');
  });
  it('ships qa-verify and the old location is gone', () => {
    expect(existsSync(resolve(root, 'skills/qa-verify/SKILL.md'))).toBe(true);
    expect(existsSync(resolve(root, '../cgremlin/core/skills/qa-verify/SKILL.md'))).toBe(false);
  });
  it('marketplace lists the plugin at ./plugin with the same version', () => {
    const mk = JSON.parse(readFileSync(resolve(root, '../.claude-plugin/marketplace.json'), 'utf8'));
    const pj = JSON.parse(readFileSync(resolve(root, '.claude-plugin/plugin.json'), 'utf8'));
    expect(mk.name).toBe('cgremlin-local');
    const entry = mk.plugins.find((p: { name: string }) => p.name === 'cgremlin');
    expect(entry.source).toBe('./plugin');
    expect(entry.version).toBe(pj.version);
  });
});
