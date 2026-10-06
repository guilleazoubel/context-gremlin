import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const repo = resolve(__dirname, '../../../..');
const pluginAgents = resolve(repo, 'plugin/agents');
const projectAgents = resolve(repo, '.claude/agents');
const NAMES = ['chore','executor-heavy','executor','matcher','planner','reader','reviewer','verifier',
  'ui-design-evaluator','ui-driver','ui-eng-evaluator','ui-pm-evaluator'];

function fm(file: string): { meta: Record<string, string>; body: string } {
  const text = readFileSync(file, 'utf8');
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`no frontmatter in ${file}`);
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2] };
}

describe('cgremlin plugin agents', () => {
  it('has exactly the 12 agents', () => {
    expect(readdirSync(pluginAgents).filter((f) => f.endsWith('.md')).sort())
      .toEqual(NAMES.map((n) => `${n}.md`).sort());
  });
  for (const n of NAMES) {
    describe(n, () => {
      const { meta, body } = fm(resolve(pluginAgents, `${n}.md`));
      it('has name, third-person description, tools, model, effort', () => {
        expect(meta.name).toBe(n);
        expect(meta.description).toMatch(/^[A-Z][a-z]+s\b/);
        expect(meta.description).not.toMatch(/\b(you|your|I)\b/i);
        expect(meta.tools.length).toBeGreaterThan(0);
        expect(['opus', 'sonnet', 'haiku']).toContain(meta.model);
        expect(['low', 'medium', 'high', 'xhigh']).toContain(meta.effort);
      });
      it('states an output format', () => {
        expect(body).toMatch(/^## Output format$/m);
      });
      it('is symlinked from .claude/agents (single source)', () => {
        const p = resolve(projectAgents, `${n}.md`);
        expect(lstatSync(p).isSymbolicLink()).toBe(true);
        expect(realpathSync(p)).toBe(realpathSync(resolve(pluginAgents, `${n}.md`)));
      });
    });
  }
  it('reviewer runs on opus (§17)', () => {
    expect(fm(resolve(pluginAgents, 'reviewer.md')).meta.model).toBe('opus');
  });
  it('verifier verdict is CONFIRMED / REFUTED / UNVERIFIABLE', () => {
    const { body } = fm(resolve(pluginAgents, 'verifier.md'));
    for (const v of ['CONFIRMED', 'REFUTED', 'UNVERIFIABLE']) expect(body).toContain(v);
  });
  it('executors can edit and run commands; ui-driver can drive a browser', () => {
    for (const n of ['executor', 'executor-heavy']) {
      const t = fm(resolve(pluginAgents, `${n}.md`)).meta.tools;
      for (const tool of ['Edit', 'Write', 'Bash']) expect(t).toContain(tool);
    }
    expect(fm(resolve(pluginAgents, 'ui-driver.md')).meta.tools).toContain('mcp__chrome-devtools');
    expect(fm(resolve(pluginAgents, 'ui-pm-evaluator.md')).meta.tools).toContain('mcp__chrome-devtools');
  });
});
