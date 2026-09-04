import { describe, expect, it } from 'vitest';
import {
  bareSkillName, renderDevelopBrief, renderFindingsBrief, renderPlanBrief,
  renderRereviewPrompt, renderReviewPrompt, STAGE_ENTRY_PROMPT,
} from '../../src/pipeline/prompts';

const sessionDir = '/s/inv-1';

describe('prompt templates', () => {
  it('never instruct the agent to call back into cgremlin', () => {
    const all = [
      renderFindingsBrief({ sessionDir, ticket: 'APP-1', intent: 'development' }),
      renderPlanBrief({ sessionDir, ticket: 'APP-1', driveToCompletion: true }),
      renderDevelopBrief({ sessionDir, ticket: 'APP-1', hasPlan: true }),
      renderDevelopBrief({ sessionDir, ticket: 'APP-1', hasPlan: false }),
      renderReviewPrompt({ sessionDir }),
      renderRereviewPrompt({ sessionDir, commitCount: 2 }),
    ];
    for (const text of all) expect(text).not.toMatch(/cgremlin --/);
  });

  it('findings brief names FINDINGS.md in the session dir, the ticket, and the AGENT_NOTE/AGENT_STATE files', () => {
    const t = renderFindingsBrief({ sessionDir, ticket: 'APP-1', intent: 'investigate_only' });
    expect(t).toContain(`${sessionDir}/FINDINGS.md`);
    expect(t).toContain('APP-1');
    expect(t).toContain(`${sessionDir}/AGENT_NOTE`);
    expect(t).toContain(`${sessionDir}/AGENT_STATE`);
    expect(t).toContain('Do NOT change code');
  });

  it('plan brief requires the exact "## Review Status" block with PM and Principal Engineer lines and the 3-round cap', () => {
    const t = renderPlanBrief({ sessionDir, ticket: 'APP-1', driveToCompletion: false });
    expect(t).toContain('## Review Status');
    expect(t).toContain('- PM: ✅ Approved');
    expect(t).toContain('- Principal Engineer: ✅ Approved');
    expect(t).toContain('## Unresolved Review Disagreement');
    expect(t).toContain('3 total rounds');
    expect(t).toContain(`${sessionDir}/PLAN.md`);
  });

  it('review prompt reproduces the legacy contract with the skill command and REVIEW.md path', () => {
    const t = renderReviewPrompt({ sessionDir });
    expect(t).toContain('Run /APFM:apfm-review and write the findings to REVIEW.md');
    expect(t).toContain("run the '## LIVE UI CHECK' section");
    expect(t).toContain('Do NOT post to GitHub');
    expect(t).toContain(`Write the output to ${sessionDir}/REVIEW.md`);
  });

  it('develop brief without a plan requires the plan gate and DEVELOPMENT.md', () => {
    const t = renderDevelopBrief({ sessionDir, ticket: 'APP-1', hasPlan: false });
    expect(t).toContain('PLAN GATE — pause');
    expect(t).toContain(`${sessionDir}/DEVELOPMENT.md`);
  });

  it('review prompt live-UI sentence uses the bare skill name, not the full command', () => {
    const t = renderReviewPrompt({ sessionDir });
    expect(t).toContain('even when apfm-review handled the code review');
    expect(t).not.toContain('even when /APFM:apfm-review');
  });

  it('review prompt can swap the skill command and omit the live UI check', () => {
    const t = renderReviewPrompt({ sessionDir, reviewSkillCommand: '/noop-review', includeLiveUiCheck: false });
    expect(t).toContain('Run /noop-review');
    expect(t).not.toContain('LIVE UI CHECK');
  });

  it('re-review prompt carries the commit count and the rereview_summary contract', () => {
    const t = renderRereviewPrompt({ sessionDir, commitCount: 3 });
    expect(t).toContain('PR updated with 3 new commit(s)');
    expect(t).toContain(`${sessionDir}/rereview_summary`);
    expect(t).toContain("'✅ N/N resolved'");
    expect(t).toContain('✅ resolved / ⚠️ partial (keep open) / ❌ still open / 🔁 regressed');
  });

  it('stage entry prompt points at BRIEF.md', () => {
    expect(STAGE_ENTRY_PROMPT(sessionDir)).toBe(`Read ${sessionDir}/BRIEF.md and follow it exactly. BEGIN NOW.`);
  });

  it('bareSkillName strips everything up to the last / or :, and trims whitespace', () => {
    expect(bareSkillName('/APFM:apfm-review')).toBe('apfm-review');
    expect(bareSkillName('/noop-review')).toBe('noop-review');
    expect(bareSkillName('apfm-review')).toBe('apfm-review');
    expect(bareSkillName('')).toBe('');
    expect(bareSkillName('/APFM:apfm-review ')).toBe('apfm-review');
  });
});
