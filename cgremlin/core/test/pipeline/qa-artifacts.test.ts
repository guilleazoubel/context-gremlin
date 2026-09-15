import { describe, expect, it } from 'vitest';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { evaluateQa, nextReviewVersion, nextVersion, parseQaVerdict } from '../../src/pipeline/artifacts';
import { parseArtifactName, ValidationError } from '../../src/api/validation';
import { pickPrimaryArtifact } from '../../src/api/artifacts';
import { SessionSchema, type Session } from '../../src/schema/session';

const CLEAN = { code: 0, signal: null } as const;

function body(verdict: string): string {
  return `# QA Verification: HB-1 — thing\n**Verdict:** ${verdict}\n\n## QA Verdict\n- Verdict: ${verdict}\n- Blocking problems: 0\n`;
}

function qaSession(): Session {
  return SessionSchema.parse({
    schemaVersion: 2,
    id: 'qa-1',
    mode: 'qa',
    createdAt: '2026-09-15T10:00:00.000Z',
    workspace: { repoUrl: 'https://github.com/acme/app.git' },
    lineage: { pipelineId: 'qa-1', parentSessionId: null, ticket: 'HB-1' },
    agent: null,
    lastRun: null,
    pr: null,
    stageStatus: 'queued',
  });
}

describe('MG-20 parseQaVerdict', () => {
  it.each([
    ['✅ Ready to deploy — all good', 'ready'],
    ['❌ Not ready — AC 2 fails', 'not_ready'],
    ['🚧 Blocked — QA unreachable', 'blocked'],
  ] as const)('reads %s', (line, expected) => {
    expect(parseQaVerdict(body(line))).toBe(expected);
  });

  it('two `## QA Verdict` headings ⇒ missing (fail-safe against a stale block)', () => {
    expect(parseQaVerdict(`${body('✅ Ready')}\n## QA Verdict\n- Verdict: ❌ Not ready\n`)).toBe('missing');
  });

  it('a verdict in a later section is not read', () => {
    const text = `## QA Verdict\n- Blocking problems: 0\n\n## Notes\n- Verdict: ✅ Ready to deploy\n`;
    expect(parseQaVerdict(text)).toBe('missing');
  });

  it('no heading at all ⇒ missing', () => {
    expect(parseQaVerdict('# QA Verification\nnothing here\n')).toBe('missing');
  });
});

describe('evaluateQa', () => {
  async function run(exit: { code: number | null; signal: string | null }, content?: string) {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/s', { recursive: true });
    if (content !== undefined) await fs.writeFile('/s/QA.md', content);
    return evaluateQa(exit as never, fs, '/s');
  }

  it('a clean exit with a ready verdict ⇒ ready', async () => {
    expect(await run(CLEAN, body('✅ Ready to deploy — all good'))).toEqual({ outcome: 'ready', verdict: 'ready' });
  });

  it('R79 — 🚧 Blocked maps to the not_ready phase', async () => {
    expect(await run(CLEAN, body('🚧 Blocked — QA unreachable'))).toEqual({ outcome: 'not_ready', verdict: 'blocked' });
  });

  it('❌ ⇒ not_ready', async () => {
    expect(await run(CLEAN, body('❌ Not ready'))).toEqual({ outcome: 'not_ready', verdict: 'not_ready' });
  });

  it('a dirty exit ⇒ failed even with a good report', async () => {
    expect(await run({ code: 1, signal: null }, body('✅ Ready'))).toEqual({ outcome: 'failed', verdict: null });
  });

  it('a missing file ⇒ failed', async () => {
    expect(await run(CLEAN)).toEqual({ outcome: 'failed', verdict: null });
  });

  it('a file with no parsable verdict ⇒ failed', async () => {
    expect(await run(CLEAN, '# QA Verification\nwrote nothing useful\n')).toEqual({ outcome: 'failed', verdict: null });
  });
});

describe('nextVersion', () => {
  it('archives QA.md to the first free QA-v<N>.md', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/s', { recursive: true });
    expect(await nextVersion(fs, '/s', 'QA')).toBe(1);
    await fs.writeFile('/s/QA-v1.md', 'x');
    await fs.writeFile('/s/QA-v2.md', 'x');
    expect(await nextVersion(fs, '/s', 'QA')).toBe(3);
  });

  it('nextReviewVersion delegates to it, behaviour unchanged', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/s', { recursive: true });
    expect(await nextReviewVersion(fs, '/s')).toBe(1);
    await fs.writeFile('/s/REVIEW-v1.md', 'x');
    expect(await nextReviewVersion(fs, '/s')).toBe(2);
    // QA's counter is independent of REVIEW's.
    expect(await nextVersion(fs, '/s', 'QA')).toBe(1);
  });
});

describe('artifact plumbing', () => {
  it('QA.md and its archive are readable', () => {
    expect(parseArtifactName('QA.md')).toBe('QA.md');
    expect(parseArtifactName('QA-v3.md')).toBe('QA-v3.md');
  });

  it('still rejects anything else', () => {
    expect(() => parseArtifactName('QA-v.md')).toThrow(ValidationError);
    expect(() => parseArtifactName('../QA.md')).toThrow(ValidationError);
    expect(() => parseArtifactName('QAX.md')).toThrow(ValidationError);
  });

  it('a qa session opens on QA.md, falling back to BRIEF.md', () => {
    const s = qaSession();
    const at = '2026-09-15T10:00:00.000Z';
    expect(pickPrimaryArtifact(s, [{ name: 'BRIEF.md', mtime: at }, { name: 'QA.md', mtime: at }])).toBe('QA.md');
    expect(pickPrimaryArtifact(s, [{ name: 'BRIEF.md', mtime: at }])).toBe('BRIEF.md');
    expect(pickPrimaryArtifact(s, [])).toBe(null);
  });
});
