import { describe, expect, it } from 'vitest';
import { loadCoreConfig, resolveCoreConfig } from '../../src/config/core-config';
import { parseRouting, resolveStageRoute } from '../../src/config/routing';
import { STAGE_NAMES } from '../../src/schema/stage';
import { InMemoryFileSystem } from '../support/in-memory-file-system';

const HOME = '/Users/e2e';
const base = { repos: ['acme/app'], me: 'me' };

/** What buildEngine does (Task 3): parse the raw routing once, resolve stages against the parsed routes. */
function viewOf(raw: Record<string, unknown>) {
  const cfg = resolveCoreConfig({ ...base, ...raw }, HOME);
  const parsed = parseRouting(cfg.routing);
  return { view: { runner: cfg.runner, runnerOptions: cfg.runnerOptions, routing: parsed.routes }, problems: parsed.problems };
}

describe('routing.<stage> (R116)', () => {
  it('absent: every stage keeps the engine-wide runner and runnerOptions.model, with no effort (legacy)', () => {
    const { view, problems } = viewOf({ runnerOptions: { model: 'opus' } });
    expect(problems).toEqual([]);
    for (const stage of STAGE_NAMES) {
      expect(resolveStageRoute(view, stage)).toEqual({ stage, runner: 'claude-code', model: 'opus', effort: null, source: 'legacy' });
    }
  });

  it('absent with a legacy codex runner: codex, its model, no effort (the legacy key is unchanged by D1)', () => {
    const { view, problems } = viewOf({ runner: 'codex', runnerOptions: { model: 'gpt-6.1-sol' } });
    expect(problems).toEqual([]);
    expect(resolveStageRoute(view, 'review')).toEqual({ stage: 'review', runner: 'codex', model: 'gpt-6.1-sol', effort: null, source: 'legacy' });
  });

  it('a routed stage takes runner, model and effort from routing; the others stay legacy', () => {
    const { view } = viewOf({ routing: { review: { runner: 'claude-code', model: 'opus', effort: 'high' } } });
    expect(resolveStageRoute(view, 'review')).toEqual({ stage: 'review', runner: 'claude-code', model: 'opus', effort: 'high', source: 'routing' });
    expect(resolveStageRoute(view, 'develop')).toEqual({ stage: 'develop', runner: 'claude-code', model: null, effort: null, source: 'legacy' });
  });

  it('a route with no model inherits runnerOptions.model only from the same runner family', () => {
    expect(resolveStageRoute(viewOf({ runnerOptions: { model: 'sonnet' }, routing: { plan: { runner: 'claude-code', effort: 'medium' } } }).view, 'plan').model).toBe('sonnet');
    expect(
      resolveStageRoute(viewOf({ runner: 'codex', runnerOptions: { model: 'gpt-6.1-sol' }, routing: { plan: { runner: 'claude-code', effort: 'medium' } } }).view, 'plan').model,
    ).toBeNull();
  });

  it('a hand-built view with no routing at all resolves as legacy', () => {
    expect(resolveStageRoute({ runner: 'claude-code', runnerOptions: {} }, 'findings')).toEqual({
      stage: 'findings', runner: 'claude-code', model: null, effort: null, source: 'legacy',
    });
  });

  it('parses escalate (with an advisor) and secondOpinion; codex is accepted there, and inert in step 2', () => {
    const { view, problems } = viewOf({
      routing: {
        review: {
          runner: 'claude-code', model: 'opus', effort: 'high',
          escalate: [{ runner: 'claude-code', model: 'opus', effort: 'xhigh', advisor: 'fable' }, { runner: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' }],
          secondOpinion: { runner: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
        },
      },
    });
    expect(problems).toEqual([]);
    expect(view.routing.review?.escalate).toEqual([
      { runner: 'claude-code', model: 'opus', effort: 'xhigh', advisor: 'fable' },
      { runner: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' },
    ]);
    expect(view.routing.review?.secondOpinion).toEqual({ runner: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
  });

  it.each(STAGE_NAMES)('D1 — codex as the primary %s runner is refused: logged, and the stage stays legacy', (stage) => {
    const { view, problems } = viewOf({ routing: { [stage]: { runner: 'codex', model: 'gpt-6.1-sol', effort: 'high' } } });
    expect(problems).toEqual([expect.stringMatching(new RegExp(`^routing\\.${stage}: .*codex`))]);
    expect(resolveStageRoute(view, stage)).toMatchObject({ runner: 'claude-code', source: 'legacy' });
  });

  it.each([
    ['an unknown stage', { implement: { runner: 'claude-code' } }],
    ['a misspelt key', { plan: { runner: 'claude-code', efort: 'high' } }],
    ['an unknown effort', { plan: { runner: 'claude-code', effort: 'ultra' } }],
    ['an unknown runner', { plan: { runner: 'gemini' } }],
    ['codex at max effort in an escalation', { plan: { runner: 'claude-code', escalate: [{ runner: 'codex', effort: 'max' }] } }],
    ['codex at max effort as a second opinion', { plan: { runner: 'claude-code', secondOpinion: { runner: 'codex', effort: 'max' } } }],
    ['a misspelt advisor key', { plan: { runner: 'claude-code', escalate: [{ runner: 'claude-code', advsor: 'fable' }] } }],
  ])('D3 — %s is reported by name, that stage falls back, and the good entries still apply', (_label, entry) => {
    const { view, problems } = viewOf({ routing: { ...entry, review: { runner: 'claude-code', effort: 'high' } } });
    expect(problems).toEqual([expect.stringMatching(/^routing\.(plan|implement): /)]);
    expect(resolveStageRoute(view, 'plan').source).toBe('legacy');
    expect(resolveStageRoute(view, 'review')).toMatchObject({ effort: 'high', source: 'routing' });
  });

  it('D3 — a routing value that is not an object is one problem, and every stage is legacy', () => {
    const { view, problems } = viewOf({ routing: 'opus everywhere' });
    expect(problems).toEqual([expect.stringMatching(/^routing: /)]);
    expect(resolveStageRoute(view, 'review').source).toBe('legacy');
  });

  it('D3 — loadCoreConfig loads a file with a bad routing entry (boot is not stopped; buildEngine reports it)', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/cfg', { recursive: true });
    const raw = { ...base, routing: { review: { runner: 'claude-code', efort: 'max' } } };
    await fs.writeFile('/cfg/test-config.json', JSON.stringify(raw));
    const cfg = await loadCoreConfig(fs, '/cfg/test-config.json', HOME);
    expect(cfg.routing).toEqual(raw.routing);
    expect(parseRouting(cfg.routing).problems).toEqual([expect.stringContaining('routing.review')]);
  });
});
