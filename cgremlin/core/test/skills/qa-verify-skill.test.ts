import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QA_CONDUCT_RULE, QA_CONTRACT_EXAMPLE } from '../../src/pipeline/prompts';

/**
 * MG-33 (E12/R82) — the permitted/forbidden list must be byte-identical
 * between what the engine renders into a brief (`QA_CONDUCT_RULE`) and what
 * ships in `skills/qa-verify/SKILL.md`, so the two cannot silently drift.
 * The skill file also carries the `## QA Verdict` marker shape the parser
 * in `pipeline/artifacts.ts` (`parseQaVerdict`) expects, so a human editing
 * the skill by hand cannot accidentally desync it from what the engine
 * actually parses.
 */

const SKILL_PATH = join(__dirname, '../../skills/qa-verify/SKILL.md');

function readSkill(): string {
  return readFileSync(SKILL_PATH, 'utf8');
}

describe('skills/qa-verify/SKILL.md', () => {
  it('exists', () => {
    expect(existsSync(SKILL_PATH)).toBe(true);
  });

  it('carries the standard SKILL frontmatter with a name and description', () => {
    const text = readSkill();
    expect(text.startsWith('---\n')).toBe(true);
    const end = text.indexOf('\n---', 4);
    expect(end).toBeGreaterThan(0);
    const frontmatter = text.slice(4, end);
    expect(frontmatter).toMatch(/^name:\s*qa-verify\s*$/m);
    expect(frontmatter).toMatch(/^description:\s*.+$/m);
  });

  it('contains exactly one `## QA Verdict` heading, matching the shape parseQaVerdict expects', () => {
    const text = readSkill();
    const headings = [...text.matchAll(/^#{2,3} QA Verdict:?\s*$/gm)];
    expect(headings).toHaveLength(1);
  });

  it('shows a `- Verdict:` line under the QA Verdict heading using one of the three glyphs', () => {
    const text = readSkill();
    const idx = text.search(/^#{2,3} QA Verdict:?\s*$/m);
    expect(idx).toBeGreaterThanOrEqual(0);
    const after = text.slice(idx);
    expect(after).toMatch(/^\s*-\s*Verdict:\s*(✅|❌|🚧)/mu);
  });

  it('carries the prohibition list byte-identical to QA_CONDUCT_RULE, the string the brief renders', () => {
    const text = readSkill();
    const start = text.indexOf('<!-- QA_CONDUCT_RULE:START -->');
    const end = text.indexOf('<!-- QA_CONDUCT_RULE:END -->');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const between = text.slice(start + '<!-- QA_CONDUCT_RULE:START -->'.length, end).trim();
    expect(between).toBe(QA_CONDUCT_RULE);
  });

  // MG-17k — the skill file carries the `QA.md` shape, and the engine renders
  // the same shape into the brief. One string, fenced, so the two cannot
  // drift the way a hand-copied example always eventually does.
  it('carries the QA.md example byte-identical to QA_CONTRACT_EXAMPLE', () => {
    const text = readSkill();
    const start = text.indexOf('<!-- QA_CONTRACT_EXAMPLE:START -->');
    const end = text.indexOf('<!-- QA_CONTRACT_EXAMPLE:END -->');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const between = text.slice(start + '<!-- QA_CONTRACT_EXAMPLE:START -->'.length, end);
    expect(between).toContain(QA_CONTRACT_EXAMPLE);
  });

  it('never mentions +clerk_test — the per-run address is not this skill’s concern', () => {
    const text = readSkill();
    expect(text).not.toContain('+clerk_test');
  });
});
