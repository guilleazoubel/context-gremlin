/**
 * "Changes so far" — the one route an engine older than Phase 10 does not serve, so the only
 * behaviour worth asserting is what happens when it answers with something else.
 */
import { describe, expect, it } from 'vitest';
import { changeSummary, parseChanges, UNKNOWN } from '../../src/model/changes';

const WIRE = {
  base: 'main',
  baseResolved: true,
  head: 'e4f5a6b',
  committed: {
    files: 8,
    additions: 240,
    deletions: 31,
    entries: [{ path: 'src/a.ts', additions: 10, deletions: 2 }],
  },
  workingTree: { files: 2, additions: 12, deletions: 0, entries: [] },
};

describe('parsing the changes route', () => {
  it('reads the shape the engine sends', () => {
    const changes = parseChanges(WIRE);
    expect(changes?.baseResolved).toBe(true);
    expect(changes?.committed).toEqual({ files: 8, additions: 240, deletions: 31 });
    expect(changes?.workingTree).toEqual({ files: 2, additions: 12, deletions: 0 });
  });

  it('falls back to the entry count when the engine sent no file count', () => {
    const changes = parseChanges({ committed: { entries: [{ path: 'a' }, { path: 'b' }] } });
    expect(changes?.committed.files).toBe(2);
    expect(changes?.committed.additions).toBeNull();
  });

  it('is null for anything that is not a change report at all', () => {
    for (const raw of [null, undefined, 'not found', 42, [], {}, { error: 'unknown route' }]) {
      expect(parseChanges(raw)).toBeNull();
    }
  });

  it('survives a report whose sides are missing or wrongly typed', () => {
    const changes = parseChanges({ committed: 'nope', workingTree: null });
    expect(changes?.committed).toEqual({ files: null, additions: null, deletions: null });
    expect(changes?.base).toBeNull();
  });
});

describe('summarising one side', () => {
  it('reads like the size cell on a PR row', () => {
    expect(changeSummary({ files: 8, additions: 240, deletions: 31 })).toBe('8 files +240/−31');
    expect(changeSummary({ files: 1, additions: 1, deletions: 0 })).toBe('1 file +1/−0');
  });

  it('says the file count alone when the line counts are unknown', () => {
    expect(changeSummary({ files: 3, additions: null, deletions: null })).toBe('3 files');
  });

  it('never fabricates a zero for an unknown change (MG-12)', () => {
    expect(changeSummary(null)).toBe(UNKNOWN);
    expect(changeSummary(undefined)).toBe(UNKNOWN);
    expect(changeSummary({ files: null, additions: 5, deletions: 5 })).toBe(UNKNOWN);
  });

  it('renders an honest empty side as zero files rather than as unknown', () => {
    expect(changeSummary({ files: 0, additions: 0, deletions: 0 })).toBe('0 files +0/−0');
  });
});
