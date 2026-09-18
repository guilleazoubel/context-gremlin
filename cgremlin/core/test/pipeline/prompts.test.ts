import { describe, expect, it } from 'vitest';
import {
  bareSkillName, EMPTY_ENVIRONMENT, renderDevelopBrief, renderFindingsBrief, renderPlanBrief,
  renderRereviewBrief, renderRereviewPrompt, renderReviewBrief, renderReviewContract,
  renderReviewPrompt, renderUiCheckProtocol, renderEnvironmentSection, renderTicketSection, renderRespondBrief,
  STAGE_ENTRY_PROMPT,
  type EnvironmentBriefContext,
} from '../../src/pipeline/prompts';

const sessionDir = '/s/inv-1';

const localCtx: EnvironmentBriefContext = {
  ...EMPTY_ENVIRONMENT,
  localUrl: 'https://local.example.com',
  localLogPath: '/s/logs/dev-server.log',
};

const previewCtx: EnvironmentBriefContext = {
  ...EMPTY_ENVIRONMENT,
  previewUrl: 'https://preview.example.com',
  bypassSecretPath: '/s/.bypass-secret',
};

// Both the local-app fields AND the preview fields set simultaneously, set directly
// (not via a later spread that would null one half out) — this is what actually
// exercises the LOCAL-APP line of renderEnvironmentSection alongside the preview line.
const bothCtx: EnvironmentBriefContext = {
  ...EMPTY_ENVIRONMENT,
  localUrl: 'https://local.example.com',
  localLogPath: '/s/logs/dev-server.log',
  previewUrl: 'https://preview.example.com',
  bypassSecretPath: '/s/.bypass-secret',
};

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
    const t = renderReviewPrompt({ sessionDir, uiCheckRendered: true });
    expect(t).toContain('Run /APFM:apfm-review.');
    // §4f — the external skill is not edited; the brief's contract wins.
    expect(t).toContain(`REVIEW.md must match the output contract in ${sessionDir}/BRIEF.md EXACTLY`);
    expect(t).toContain("run the '## LIVE UI CHECK' section");
    // Phase 20: the prompt now hands posting authority to the brief's section.
    expect(t).not.toContain('Do NOT post to GitHub');
    expect(t).toContain("'## Posting' section");
    expect(t).toContain(`Write the output to ${sessionDir}/REVIEW.md`);
  });

  it('develop brief without a plan requires the plan gate and DEVELOPMENT.md', () => {
    const t = renderDevelopBrief({ sessionDir, ticket: 'APP-1', hasPlan: false });
    expect(t).toContain('PLAN GATE — pause');
    expect(t).toContain(`${sessionDir}/DEVELOPMENT.md`);
  });

  it('review prompt live-UI sentence uses the bare skill name, not the full command', () => {
    const t = renderReviewPrompt({ sessionDir, uiCheckRendered: true });
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

  it('renderFindingsBrief and renderDevelopBrief are byte-identical to pre-Phase-5 output when env is omitted (regression pin)', () => {
    expect(renderFindingsBrief({ sessionDir, ticket: 'APP-1', intent: 'development' })).toMatchSnapshot();
    expect(renderFindingsBrief({ sessionDir, ticket: 'APP-1', intent: 'investigate_only' })).toMatchSnapshot();
    expect(renderDevelopBrief({ sessionDir, ticket: 'APP-1', hasPlan: true })).toMatchSnapshot();
    expect(renderDevelopBrief({ sessionDir, ticket: 'APP-1', hasPlan: false })).toMatchSnapshot();
  });
});

describe('renderEnvironmentSection', () => {
  it('is empty when the context has no non-null field', () => {
    expect(renderEnvironmentSection(EMPTY_ENVIRONMENT)).toBe('');
  });

  it('renders only the local app when only localUrl+localLogPath are set', () => {
    const t = renderEnvironmentSection(localCtx);
    expect(t).toContain('https://local.example.com');
    expect(t).toContain('/s/logs/dev-server.log');
    expect(t).not.toContain('Vercel preview');
    expect(t).not.toContain('Clerk');
  });

  it('renders the local-unavailable line with the reason and the do-not-start warning', () => {
    const t = renderEnvironmentSection({ ...EMPTY_ENVIRONMENT, localUnavailableReason: 'port 8080 is held by pid 4242' });
    expect(t).toContain('Local app: UNAVAILABLE — port 8080 is held by pid 4242');
    expect(t).toContain('Do not attempt to start it yourself');
  });

  it('renders the preview URL and the bypass-secret sentence pointing at the session .bypass-secret file', () => {
    const t = renderEnvironmentSection(previewCtx);
    expect(t).toContain('https://preview.example.com');
    expect(t).toContain('/s/.bypass-secret');
  });

  it('renders the Clerk test-user template and code', () => {
    const t = renderEnvironmentSection({ ...EMPTY_ENVIRONMENT, clerk: { emailTemplate: 'uicheck-{key}+clerk_test@example.com', verificationCode: '424242' } });
    expect(t).toContain('uicheck-{key}+clerk_test@example.com');
    expect(t).toContain('424242');
  });

  it('MG-1 secret-never-in-brief (type pin): none of the five briefs can contain the raw secret value, because the renderers never receive it — only a path (the behavioural guard is C2, EnvironmentService.writeBypassSecret)', () => {
    const ctx: EnvironmentBriefContext = { ...previewCtx, bypassSecretPath: '/s/.bypass-secret' };
    const briefs = [
      renderFindingsBrief({ sessionDir, ticket: 'APP-1', intent: 'investigate_only', env: ctx }),
      renderDevelopBrief({ sessionDir, ticket: 'APP-1', hasPlan: true, env: ctx }),
      renderReviewBrief({ sessionDir, prNumber: 123, env: ctx }),
      renderRereviewBrief({ sessionDir, prNumber: 123, commitCount: 2, env: ctx }),
    ];
    for (const b of briefs) expect(b).not.toContain('S3CRET-VALUE');
  });

  it('MG-7 no-agent-callback: none of the briefs/prompts instruct calling back into the engine', () => {
    // bothCtx has BOTH localUrl/localLogPath AND previewUrl/bypassSecretPath set
    // simultaneously (see fixture above) — unlike the old `{ ...localCtx, ...previewCtx }`
    // merge, this actually exercises the LOCAL-APP line of renderEnvironmentSection in
    // every renderer below that emits the '## Environment' section (develop/review/rereview).
    const ctx = bothCtx;
    const findings = renderFindingsBrief({ sessionDir, ticket: 'APP-1', intent: 'investigate_only', env: ctx });
    const plan = renderPlanBrief({ sessionDir, ticket: 'APP-1', driveToCompletion: false });
    const develop = renderDevelopBrief({ sessionDir, ticket: 'APP-1', hasPlan: true, env: ctx });
    const review = renderReviewBrief({ sessionDir, prNumber: 123, env: ctx });
    const rereview = renderRereviewBrief({ sessionDir, prNumber: 123, commitCount: 2, env: ctx });
    const all = [findings, plan, develop, review, rereview];
    for (const b of all) {
      expect(b).not.toContain('cgremlin --run-local');
      expect(b).not.toContain('cgremlin --stop-local');
      expect(b).not.toContain('engine.sock');
      expect(b).not.toContain('POST /sessions/');
      expect(b).not.toContain('curl ');
    }
    // Positive control: prove the local-app line (and the preview line) actually
    // rendered in each of the three renderers that emit '## Environment', so the
    // negative assertions above are known to have exercised that code path.
    for (const b of [develop, review, rereview]) {
      expect(b).toContain(`Local app: ${ctx.localUrl}`);
      expect(b).toContain(`Vercel preview: ${ctx.previewUrl}`);
    }
    // positive control: the bare '/sessions/'-shaped session path is fine — the guard
    // only outlaws the callback patterns above, not legitimate session-dir paths.
    expect(STAGE_ENTRY_PROMPT('/s')).toContain('/s/BRIEF.md');
  });
});

describe('renderUiCheckProtocol', () => {
  it('renders the OBSERVE mode marker and not FIX, and vice versa', () => {
    const observe = renderUiCheckProtocol('observe', 'the target', previewCtx);
    const fix = renderUiCheckProtocol('fix', 'the target', previewCtx);
    expect(observe).toContain('**Mode — OBSERVE:**');
    expect(observe).not.toContain('**Mode — FIX:**');
    expect(fix).toContain('**Mode — FIX:**');
    expect(fix).not.toContain('**Mode — OBSERVE:**');
    for (const t of [observe, fix]) {
      expect(t).toContain('## LIVE UI CHECK — PM + Designer lenses (dedicated subagents)');
      expect(t).toContain('**PM subagent (product manager verifying the ticket):**');
      expect(t).toContain('**Designer subagent (designer checking pixel fidelity):**');
      expect(t).toContain('finding-N-figma.png');
      expect(t).toContain('**Degradation:**');
      expect(t).toContain('+clerk_test@example.com');
    }
  });

  it('is empty when neither localUrl nor previewUrl is set (R14)', () => {
    expect(renderUiCheckProtocol('observe', 'the target', EMPTY_ENVIRONMENT)).toBe('');
    expect(renderUiCheckProtocol('fix', 'the target', EMPTY_ENVIRONMENT)).toBe('');
  });

  it('uses the custom clerk.verificationCode when given, and 424242 when clerk is null but a URL exists', () => {
    const custom = renderUiCheckProtocol('fix', 't', { ...previewCtx, clerk: { emailTemplate: 'x', verificationCode: '999999' } });
    expect(custom).toContain('999999');
    expect(custom).not.toContain('424242');
    const fallback = renderUiCheckProtocol('fix', 't', previewCtx);
    expect(fallback).toContain('424242');
  });
});

describe('renderReviewContract (verbatim legacy REVIEW.md contract, R9)', () => {
  it('contains the required headings, table header, legend glyphs, and section markers', () => {
    const t = renderReviewContract();
    expect(t).toContain('## Output — write `REVIEW.md` in this directory, EXACTLY this structure');
    expect(t).toContain('# PR Review: #<number> — <title>');
    expect(t).toContain('**Does it do what the ticket asked?**');
    expect(t).toContain('**How deep did I look?**');
    expect(t).toContain('## Summary');
    expect(t).toContain('## What I found');
    expect(t).toContain('| # | Severity | Where | Issue | Status |');
    expect(t).toContain('## Details');
    expect(t).toContain('## Verdict');
    expect(t).toContain('## Review History');
    expect(t).toContain('| Version | Date | Commit | Action |');
  });

  it('all six legend glyphs appear across a rendered review brief (severity list + contract)', () => {
    const t = renderReviewBrief({ sessionDir, prNumber: 123 });
    for (const glyph of ['🔴', '🟠', '🟡', '🔧', '📋', '🎨']) expect(t).toContain(glyph);
  });

  it('anchor rule: every <a id="fN"> has a matching [N](#fN) table link', () => {
    const t = renderReviewContract();
    expect(t).toContain('<a id="f1"></a>');
    expect(t).toContain('<a id="f2"></a>');
    expect(t).toContain('<a id="f4"></a>');
    expect(t).toContain('[1](#f1)');
    expect(t).toContain('[4](#f4)');
    expect(t).toContain('Anchor ids never change across re-reviews (finding 1 is always `f1`)');
    const anchorIds = [...t.matchAll(/<a id="f(\d+)"><\/a>/g)].map((m) => m[1]);
    const linkIds = [...t.matchAll(/\[(\d+)\]\(#f\1\)/g)].map((m) => m[1]);
    for (const id of anchorIds) expect(linkIds).toContain(id);
  });

  it('renderReviewBrief and renderRereviewBrief both embed the full contract', () => {
    const review = renderReviewBrief({ sessionDir, prNumber: 123 });
    const rereview = renderRereviewBrief({ sessionDir, prNumber: 123, commitCount: 2 });
    for (const t of [review, rereview]) {
      expect(t).toContain('## Output — write `REVIEW.md` in this directory, EXACTLY this structure');
      expect(t).toContain('## Review History');
    }
  });
});

describe('renderReviewBrief / renderRereviewBrief', () => {
  it('review brief contains the Link rule and the Tier-0 intent line', () => {
    const t = renderReviewBrief({ sessionDir, prNumber: 123 });
    expect(t).toContain('https://github.com/<owner>/<repo>/blob/<full-sha>/');
    expect(t).toContain('FULL 40-char SHA');
    expect(t).toContain('Intent alignment:');
    expect(t).toContain('✅ satisfies / ⚠️ partial / ❌ diverges');
  });

  it('review brief contains the header, environment section and OBSERVE protocol when env is given; contains neither heading when env is omitted, but still the full contract', () => {
    const withEnv = renderReviewBrief({ sessionDir, prNumber: 123, env: previewCtx });
    expect(withEnv).toContain('# REVIEW — PR #123');
    expect(withEnv).toContain('## Environment');
    expect(withEnv).toContain('**Mode — OBSERVE:**');

    const withoutEnv = renderReviewBrief({ sessionDir, prNumber: 123 });
    expect(withoutEnv).not.toContain('## Environment');
    expect(withoutEnv).not.toContain('## LIVE UI CHECK');
    expect(withoutEnv).toContain('## Output — write `REVIEW.md` in this directory, EXACTLY this structure');
  });

  it('Phase 10: selfReview:true adds one line stating this is a self-review of the author\'s own PR; absent by default', () => {
    const selfReviewBrief = renderReviewBrief({ sessionDir, prNumber: 123, selfReview: true });
    expect(selfReviewBrief).toContain('self-review');
    expect(selfReviewBrief.toLowerCase()).toContain('own pr');

    const ordinaryBrief = renderReviewBrief({ sessionDir, prNumber: 123 });
    expect(ordinaryBrief).not.toContain('self-review');

    const explicitFalse = renderReviewBrief({ sessionDir, prNumber: 123, selfReview: false });
    expect(explicitFalse).not.toContain('self-review');
  });

  it('rereview brief contains the header and the commit count', () => {
    const t = renderRereviewBrief({ sessionDir, prNumber: 123, commitCount: 2 });
    expect(t).toContain('# RE-REVIEW — PR #123');
    expect(t).toContain('2 new commit(s)');
  });
});

describe('renderDevelopBrief environment-aware step 5', () => {
  it('contains the local URL and the log path when the context has them', () => {
    const t = renderDevelopBrief({ sessionDir, ticket: 'APP-1', hasPlan: true, env: localCtx });
    expect(t).toContain('The local app is already running at https://local.example.com');
    expect(t).toContain('Watch /s/logs/dev-server.log');
  });

  it('omits step 5\'s local half entirely when localUrl is null', () => {
    const t = renderDevelopBrief({ sessionDir, ticket: 'APP-1', hasPlan: true });
    expect(t).not.toContain('The local app is already running at');
    expect(t).toContain("5. **Verify.**");
  });
});

describe('renderReviewPrompt gating (R14)', () => {
  it('omits the LIVE UI CHECK sentence when uiCheckRendered is omitted (fail-closed default)', () => {
    const t = renderReviewPrompt({ sessionDir });
    expect(t).not.toContain('LIVE UI CHECK');
  });

  it('with uiCheckRendered true, the sentence points at BRIEF.md, not CLAUDE.md', () => {
    const t = renderReviewPrompt({ sessionDir, uiCheckRendered: true });
    expect(t).toContain(`'## LIVE UI CHECK' section in ${sessionDir}/BRIEF.md`);
    expect(t).not.toContain('CLAUDE.md');
  });

  it('with uiCheckRendered false, no LIVE UI CHECK sentence at all', () => {
    const t = renderReviewPrompt({ sessionDir, uiCheckRendered: false });
    expect(t).not.toContain('LIVE UI CHECK');
  });

  it('renderRereviewPrompt does not contain CLAUDE.md', () => {
    const t = renderRereviewPrompt({ sessionDir, commitCount: 3 });
    expect(t).not.toContain('CLAUDE.md');
  });
});

describe('F2: previewStatus (non-DEPLOYED preview status is not silently dropped)', () => {
  it('EMPTY_ENVIRONMENT.previewStatus is null', () => {
    expect(EMPTY_ENVIRONMENT.previewStatus).toBeNull();
  });

  it('renders the "deployment status" note when previewStatus is set and not DEPLOYED', () => {
    const t = renderEnvironmentSection({
      ...EMPTY_ENVIRONMENT,
      previewUrl: 'https://preview.example.com',
      previewStatus: 'PENDING',
    });
    expect(t).toContain('https://preview.example.com');
    expect(t).toContain('(deployment status PENDING — may still be building; retry the page if it does not load)');
  });

  it('renders the plain preview line with no status note when previewStatus is DEPLOYED', () => {
    const t = renderEnvironmentSection({
      ...EMPTY_ENVIRONMENT,
      previewUrl: 'https://preview.example.com',
      previewStatus: 'DEPLOYED',
    });
    expect(t).toContain('- Vercel preview: https://preview.example.com');
    expect(t).not.toContain('deployment status');
  });

  it('renders the plain preview line with no status note when previewStatus is null', () => {
    const t = renderEnvironmentSection({
      ...EMPTY_ENVIRONMENT,
      previewUrl: 'https://preview.example.com',
      previewStatus: null,
    });
    expect(t).toContain('- Vercel preview: https://preview.example.com');
    expect(t).not.toContain('deployment status');
  });

});

describe('F3: renderFindingsBrief gets the "## Environment" section (mirrors renderDevelopBrief)', () => {
  it('includes "## Environment" with the local app URL and log path when the environment has a local app', () => {
    const t = renderFindingsBrief({ sessionDir, ticket: 'APP-1', intent: 'development', env: localCtx });
    expect(t).toContain('## Environment');
    expect(t).toContain(`Local app: ${localCtx.localUrl}`);
    expect(t).toContain(localCtx.localLogPath as string);
  });
});

// ---------------------------------------------------------------------------
// Phase 9 / Task A7 — the gated `## Ticket` brief section (R18).
// ---------------------------------------------------------------------------

describe('renderTicketSection (R18)', () => {
  const base = {
    key: 'HB-627',
    summary: 'Parking lot should not show drafts',
    status: 'In Progress',
    url: 'https://aplaceformom.atlassian.net/browse/HB-627',
    descriptionText: 'The parking lot must show open PRs only.',
    comments: [
      { author: 'Jane', at: '2026-09-09T09:00:00.000Z', bodyText: 'Newest comment.' },
      { author: 'Bob', at: '2026-09-08T09:00:00.000Z', bodyText: 'Older comment.' },
    ],
  };

  it('returns the empty string for an empty context', () => {
    expect(renderTicketSection(null)).toBe('');
  });

  it('renders the key, summary, status, description and comments', () => {
    const text = renderTicketSection(base);
    expect(text.startsWith('## Ticket HB-627 — Parking lot should not show drafts')).toBe(true);
    expect(text).toContain('In Progress');
    expect(text).toContain('The parking lot must show open PRs only.');
    expect(text).toContain('Jane');
    expect(text).toContain('Newest comment.');
    expect(text).toContain('Older comment.');
  });

  it('caps at 5 comments and SAYS SO', () => {
    const many = {
      ...base,
      comments: Array.from({ length: 9 }, (_, i) => ({
        author: `A${i}`,
        at: `2026-09-0${i + 1}T00:00:00.000Z`,
        bodyText: `body ${i}`,
      })),
    };
    const text = renderTicketSection(many);
    expect(text).toContain('body 0');
    expect(text).toContain('body 4');
    expect(text).not.toContain('body 5');
    expect(text.toLowerCase()).toContain('truncated');
  });

  it('caps each comment at 2000 characters and says so', () => {
    const long = { ...base, comments: [{ author: 'Jane', at: '2026-09-09T09:00:00.000Z', bodyText: 'x'.repeat(5000) }] };
    const text = renderTicketSection(long);
    expect(text).not.toContain('x'.repeat(2100));
    expect(text.toLowerCase()).toContain('truncated');
  });

  it('caps the whole section at 12000 characters and says so', () => {
    const huge = {
      ...base,
      descriptionText: 'y'.repeat(11_000),
      comments: [
        { author: 'Jane', at: '2026-09-09T09:00:00.000Z', bodyText: 'z'.repeat(2000) },
        { author: 'Bob', at: '2026-09-08T09:00:00.000Z', bodyText: 'z'.repeat(2000) },
      ],
    };
    const text = renderTicketSection(huge);
    expect(text.length).toBeLessThanOrEqual(12_000);
    expect(text.toLowerCase()).toContain('truncated');
  });

  it('never carries a credential (MG-5)', () => {
    expect(renderTicketSection(base)).not.toContain('apiToken');
    expect(renderTicketSection(base)).not.toContain('Authorization');
  });
});

describe('the ## Ticket block in the findings and develop briefs (R18)', () => {
  const ticket = {
    key: 'HB-627',
    summary: 'Do the thing',
    status: 'In Progress',
    url: 'https://aplaceformom.atlassian.net/browse/HB-627',
    descriptionText: 'the description',
    comments: [],
  };

  it('appears only when a ticket was fetched', () => {
    const without = renderFindingsBrief({ sessionDir: '/s', ticket: 'HB-627', intent: 'investigate_only' });
    expect(without).not.toContain('## Ticket HB-627');
    const with_ = renderFindingsBrief({ sessionDir: '/s', ticket: 'HB-627', intent: 'investigate_only', ticketContext: ticket });
    expect(with_).toContain('## Ticket HB-627 — Do the thing');
    expect(with_).toContain('the description');
  });

  it('the develop brief carries it too', () => {
    const brief = renderDevelopBrief({ sessionDir: '/s', ticket: 'HB-627', hasPlan: false, ticketContext: ticket });
    expect(brief).toContain('## Ticket HB-627 — Do the thing');
  });

  it('the existing "fetch it via getJiraIssue" line is reworded rather than deleted', () => {
    const brief = renderFindingsBrief({ sessionDir: '/s', ticket: 'HB-627', intent: 'investigate_only', ticketContext: ticket });
    expect(brief).toContain('getJiraIssue');
    expect(brief.toLowerCase()).toContain('only if you need more');
  });
});

// ---------------------------------------------------------------------------
// Phase 9 / Task A9 — renderRespondBrief (R50, R55).
// ---------------------------------------------------------------------------

describe('renderRespondBrief (R50)', () => {
  const thread = (id: string, comments: Array<{ author: string; body: string }>) => ({
    id,
    isResolved: false,
    isOutdated: false,
    path: 'src/a.ts',
    line: 12,
    truncated: false,
    comments: comments.map((c, i) => ({
      author: c.author,
      body: c.body,
      createdAt: `2026-09-0${i + 1}T00:00:00Z`,
      url: `https://github.com/acme/app/pull/12#discussion_r${id}${i}`,
    })),
  });

  const ctx = {
    sessionDir: '/s/respond-1',
    prRepo: 'acme/app',
    prNumber: 12,
    threads: [
      thread('T1', [
        { author: 'jane', body: 'comment one' },
        { author: 'me-user', body: 'comment two' },
        { author: 'jane', body: 'comment three' },
      ]),
      thread('T2', [
        { author: 'bob', body: 'comment four' },
        { author: 'me-user', body: 'comment five' },
      ]),
    ],
    reviews: [
      { author: 'jane', state: 'CHANGES_REQUESTED', body: 'see inline', submittedAt: '2026-09-03T00:00:00Z' },
      { author: 'bob', state: 'APPROVED', body: null, submittedAt: '2026-09-04T00:00:00Z' },
    ],
    reviewDecision: 'CHANGES_REQUESTED',
    failingChecks: [{ name: 'unit', detailsUrl: 'https://ci/unit' }],
    changedFiles: 7,
    additions: 120,
    deletions: 3,
  };

  it("returns '' with nothing fetched", () => {
    expect(
      renderRespondBrief({
        sessionDir: '/s/x',
        prRepo: 'acme/app',
        prNumber: 12,
        threads: [],
        reviews: [],
        reviewDecision: null,
        failingChecks: [],
        changedFiles: null,
        additions: null,
        deletions: null,
      }),
    ).toBe('');
  });

  it('contains EVERY one of the five comment bodies — the regression the legacy comments(first:1) caused', () => {
    const text = renderRespondBrief(ctx);
    for (const body of ['comment one', 'comment two', 'comment three', 'comment four', 'comment five']) {
      expect(text).toContain(body);
    }
    expect(text).toContain('src/a.ts:12');
    expect(text).toContain('@jane');
  });

  it('labels resolved and outdated threads rather than dropping them', () => {
    const text = renderRespondBrief({
      ...ctx,
      threads: [{ ...thread('T3', [{ author: 'jane', body: 'old point' }]), isResolved: true, isOutdated: true }],
    });
    expect(text).toContain('old point');
    expect(text).toContain('resolved');
    expect(text).toContain('outdated');
  });

  it('carries the per-reviewer states, the reviewDecision, the failing checks and the diff summary', () => {
    const text = renderRespondBrief(ctx);
    expect(text).toContain('**@jane** — CHANGES_REQUESTED');
    expect(text).toContain('**@bob** — APPROVED');
    expect(text).toContain('**Decision:** CHANGES_REQUESTED');
    expect(text).toContain('unit — https://ci/unit');
    expect(text).toContain('7 files changed, +120/−3');
  });

  it('the ## Ticket block is renderTicketSection output BYTE-FOR-BYTE', () => {
    const ticketContext = {
      key: 'HB-627',
      summary: 'Do the thing',
      status: 'In Progress',
      url: 'https://aplaceformom.atlassian.net/browse/HB-627',
      descriptionText: 'the description',
      comments: [],
    };
    const text = renderRespondBrief({ ...ctx, ticketContext });
    expect(text).toContain(renderTicketSection(ticketContext));
  });

  it('the caps truncate and SAY so', () => {
    const many = {
      ...ctx,
      threads: Array.from({ length: 60 }, (_, i) => thread(`T${i}`, [{ author: 'jane', body: `body ${i}` }])),
    };
    const text = renderRespondBrief(many);
    expect(text).toContain('body 49');
    expect(text).not.toContain('body 50');
    expect(text.toLowerCase()).toContain('truncated');

    const chatty = {
      ...ctx,
      threads: [thread('T1', Array.from({ length: 30 }, (_, i) => ({ author: 'jane', body: `c${i}` })))],
    };
    expect(renderRespondBrief(chatty).toLowerCase()).toContain('truncated');

    const verbose = { ...ctx, threads: [thread('T1', [{ author: 'jane', body: 'x'.repeat(5000) }])] };
    const verboseText = renderRespondBrief(verbose);
    expect(verboseText).not.toContain('x'.repeat(2100));
    expect(verboseText.toLowerCase()).toContain('truncated');
    expect(verboseText.length).toBeLessThanOrEqual(40_000);
  });

  it('carries the reconcile-first instruction and the legacy COMMENTS.md entry shape', () => {
    const text = renderRespondBrief(ctx);
    expect(text).toContain('Reconcile FIRST');
    for (const field of [
      '**Thread:**',
      '**From:**',
      '**Where:**',
      '**Comment:**',
      '**Verdict:**',
      '**Reasoning:**',
      '**Proposed reply:**',
      '**Proposed fix:**',
      '**Status:**',
    ]) {
      expect(text).toContain(field);
    }
    expect(text).toContain('COMMENTS.md');
  });

  // Phase 20 reversed R55: the respond agent now posts its replies itself.
  // What it still may NOT do is resolve a thread or land the PR, and it never
  // calls back into the engine's dead CLI.
  it('MG-14: the brief instructs a threaded reply, and still forbids resolving or landing the PR', () => {
    const text = renderRespondBrief(ctx);
    expect(text).toContain('## Posting');
    expect(text).toContain('Reply INSIDE the thread');
    expect(text).toContain('Do NOT resolve threads');
    expect(text).toContain('never force-push');
    expect(text).toMatch(/never merge, close, edit, re-title or mark this pull request ready/i);
    expect(text).not.toContain('--reply-comment');
    expect(text).not.toContain('--resolve-comment');
    expect(text).not.toContain('--push-fix');
  });
});
