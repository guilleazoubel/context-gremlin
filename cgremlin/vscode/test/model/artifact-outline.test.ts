/**
 * Phase 17 §3 / task 6 — reading the structure out of an artifact, and NEVER guessing.
 *
 * The rule the whole module is built to hold (MG-17j): parse, never assume. A file the parsers
 * cannot read yields `null` and empty lists, so the pane says "unstructured" by saying nothing —
 * a fabricated `0 findings` would say "clean", which is a different and wrong claim.
 *
 * Pure module, DOM-free and editor-free (MG-B1).
 */
import { describe, expect, it } from 'vitest';
import {
  fileRefOf,
  findingsOf,
  severityCountsOf,
  stripLeadingH1,
  ticketAnswerOf,
  verdictOf,
} from '../../src/model/artifact-outline';

const CONTRACT = [
  '# PR Review: #2180 — Add web-content read endpoint',
  '**Verdict:** 🔄 Request changes — the endpoint ignores the locale parameter.',
  '**Scope:** the diff of #2180 and the ticket.',
  '**Does it do what the ticket asked?** mostly',
  '',
  '## What I found',
  '',
  '| # | Severity | Where | What |',
  '| --- | --- | --- | --- |',
  '| [1](#f1) | 🔴 Critical | `web-content.ts:88` | locale param is dropped |',
  '| [2](#f2) | 🔧 Maintainability | `ui/list.tsx:40` | route and mapper mixed |',
  '',
  '## Details',
  '',
  '<a id="f1"></a>',
  '### 1. Locale parameter is dropped before the query',
  '- **Severity:** 🔴 Critical',
  '- **Where:** `web-content.ts:88`',
  '- **Status:** open',
  '',
  "**What's wrong:** the locale segment never reaches the query.",
  '',
  '<a id="f2"></a>',
  '### 2. Route and mapper mixed in one file',
  '- **Severity:** 🔧 Maintainability',
  '- **Where:** `ui/list.tsx:40`',
  '- **Status:** open',
  '',
].join('\n');

const LEGACY_REVIEW = [
  '# PR Review: #9 — old shape',
  '',
  '## Details',
  '',
  '### 1. Something broke',
  '**Severity:** 🔴 Critical   **Where:** `f.ts:88`   **Status:** open',
  '',
  '## Verdict',
  '',
  '🔄 Request changes — two blocking problems.',
  '',
].join('\n');

const LEGACY_QA = ['# QA', '', '## QA Verdict', '', '- Verdict: ✅ Ready to deploy', ''].join('\n');

describe('stripLeadingH1', () => {
  it('removes the artifact’s own title so the tab prints it once (MG-17a)', () => {
    const { title, body } = stripLeadingH1(CONTRACT);
    expect(title).toBe('PR Review: #2180 — Add web-content read endpoint');
    expect(body.startsWith('**Verdict:**')).toBe(true);
    expect(body).not.toContain('# PR Review');
  });

  it('leaves a body that does not start with a heading alone', () => {
    expect(stripLeadingH1('plain prose\n')).toEqual({ title: null, body: 'plain prose\n' });
  });
});

describe('verdictOf', () => {
  it('reads the contract’s bold line, its tone glyph, its label and its sentence', () => {
    expect(verdictOf(CONTRACT)).toEqual({
      tone: 'mixed',
      label: 'Request changes',
      sentence: 'the endpoint ignores the locale parameter.',
    });
  });

  it('falls back to a legacy trailing `## Verdict` section (MG-17j)', () => {
    expect(verdictOf(LEGACY_REVIEW)?.label).toBe('Request changes');
  });

  it('falls back to the frozen QA `- Verdict:` line (MG-17j)', () => {
    expect(verdictOf(LEGACY_QA)).toEqual({
      tone: 'pass',
      label: 'Ready to deploy',
      sentence: '',
    });
  });

  it('returns null for prose, so the pane draws no strip at all', () => {
    expect(verdictOf('# Notes\n\nI looked at the diff and it seemed fine.\n')).toBeNull();
  });
});

describe('ticketAnswerOf', () => {
  it('reads the review’s fourth line', () => {
    expect(ticketAnswerOf(CONTRACT)).toBe('mostly');
    expect(ticketAnswerOf(LEGACY_QA)).toBeNull();
  });
});

describe('findingsOf', () => {
  it('reads the one-field-per-line form, with its anchor', () => {
    const findings = findingsOf(CONTRACT);
    expect(findings.map((f) => f.anchor)).toEqual(['f1', 'f2']);
    expect(findings[0]).toEqual({
      anchor: 'f1',
      number: 1,
      title: 'Locale parameter is dropped before the query',
      severity: 'Critical',
      where: 'web-content.ts:88',
      status: 'open',
    });
  });

  it('reads the legacy three-fields-on-one-line form (MG-17j)', () => {
    expect(findingsOf(LEGACY_REVIEW)).toEqual([
      {
        anchor: 'f1',
        number: 1,
        title: 'Something broke',
        severity: 'Critical',
        where: 'f.ts:88',
        status: 'open',
      },
    ]);
  });

  it('finds nothing in prose rather than inventing a finding', () => {
    expect(findingsOf('# Notes\n\nnothing structured here\n')).toEqual([]);
  });
});

describe('severityCountsOf', () => {
  it('counts the DETAILS, never the summary table, which would double-count', () => {
    expect(severityCountsOf(CONTRACT)).toEqual([
      { word: 'Critical', count: 1 },
      { word: 'Maintainability', count: 1 },
    ]);
  });

  it('returns an empty list for an unparseable artifact — never a fabricated zero', () => {
    expect(severityCountsOf('# Notes\n\nprose\n')).toEqual([]);
  });
});

describe('fileRefOf', () => {
  it('answers on a repo-relative path:line and on a range', () => {
    expect(fileRefOf('web-content.ts:88')).toEqual({ path: 'web-content.ts', line: 88 });
    expect(fileRefOf('src/api/web-content.ts:88-L92')).toEqual({
      path: 'src/api/web-content.ts',
      line: 88,
    });
  });

  it('refuses anything that is not exactly a path:line', () => {
    for (const text of ['npm run build', 'web-content.ts', ':88', 'HB-1489', 'a.ts:0']) {
      expect(fileRefOf(text)).toBeNull();
    }
  });
});
