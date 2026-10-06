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
});
