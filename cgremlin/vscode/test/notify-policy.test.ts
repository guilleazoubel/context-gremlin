import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { decideNotifications } from '../src/model/notify-policy';
import type { AttentionItem, AttentionReason } from '../src/model/items';

function make(
  ref: string,
  reasons: AttentionReason[],
  overrides: { needsYou?: boolean; needsAttention?: boolean; source?: string } = {},
): AttentionItem {
  const needsAttention = overrides.needsAttention ?? reasons.length > 0;
  return {
    source: (overrides.source ?? 'session') as AttentionItem['source'],
    ref,
    id: ref.slice(ref.indexOf(':') + 1),
    title: `Item ${ref}`,
    repoOrContext: 'acme/web',
    attention: {
      needsAttention,
      needsYou: overrides.needsYou ?? needsAttention,
      reasons,
      since: '2026-09-10T08:00:00.000Z',
      signature: `${reasons.join(',')}|2026-09-10T08:00:00.000Z`,
      acked: false,
    },
    links: {
      sessionId: null,
      worktreePath: null,
      prRepo: null,
      prNumber: null,
      prUrl: null,
      ticket: null,
      primaryArtifact: null,
    },
    mode: 'review',
    stageStatus: 'ready',
    running: false,
    claimed: false,
  };
}

describe('MG-B2 only-needs-you-pops', () => {
  it('pops for an item entering needsYou', () => {
    const popups = decideNotifications([], [make('session:a', ['review_ready'])], 'all');
    expect(popups).toHaveLength(1);
    expect(popups[0]).toMatchObject({ ref: 'session:a', source: 'session', reasons: ['review_ready'] });
    expect(popups[0]?.message).toContain('review_ready');
  });

  it('stays quiet when the reason set did not change', () => {
    const prev = [make('session:a', ['review_ready'])];
    expect(decideNotifications(prev, [make('session:a', ['review_ready'])], 'all')).toEqual([]);
  });

  it('pops again when an item gains a reason', () => {
    const prev = [make('session:a', ['review_ready'])];
    const next = [make('session:a', ['needs_input', 'review_ready'])];
    expect(decideNotifications(prev, next, 'all')).toHaveLength(1);
  });

  it('stays quiet when an item only lost a reason', () => {
    const prev = [make('session:a', ['needs_input', 'review_ready'])];
    const next = [make('session:a', ['review_ready'])];
    expect(decideNotifications(prev, next, 'all')).toEqual([]);
  });

  it('never pops a badge-only item — the core says so, not a local reason list', () => {
    const badgeOnly = make('session:a', ['local_prereq_failed'], { needsAttention: true, needsYou: false });
    expect(decideNotifications([], [badgeOnly], 'all')).toEqual([]);
  });

  it('treats needs-you-only exactly as all, because only needs-you items ever pop', () => {
    const next = [
      make('session:a', ['review_ready']),
      make('session:b', ['local_prereq_failed'], { needsAttention: true, needsYou: false }),
    ];
    expect(decideNotifications([], next, 'needs-you-only')).toEqual(decideNotifications([], next, 'all'));
    expect(decideNotifications([], next, 'needs-you-only')).toHaveLength(1);
  });

  it('returns nothing at all when notifications are off', () => {
    expect(decideNotifications([], [make('session:a', ['review_ready'])], 'off')).toEqual([]);
  });

  it('pops two items in next order', () => {
    const next = [make('session:b', ['blocked']), make('session:a', ['plan_ready'])];
    expect(decideNotifications([], next, 'all').map((p) => p.ref)).toEqual(['session:b', 'session:a']);
  });

  it('diffs an item of an unrecognized source by ref, like any other', () => {
    const prev = [make('jira:ING-9', ['needs_input'], { source: 'jira' })];
    const same = [make('jira:ING-9', ['needs_input'], { source: 'jira' })];
    const grown = [make('jira:ING-9', ['blocked', 'needs_input'], { source: 'jira' })];
    expect(decideNotifications([], prev, 'all')).toHaveLength(1);
    expect(decideNotifications(prev, same, 'all')).toEqual([]);
    expect(decideNotifications(prev, grown, 'all')).toHaveLength(1);
  });

  it('keeps the needs-you rule in the core — the extension has no copy of it', () => {
    // Assembled rather than written out, so the phase-7 DoD grep over the whole package stays empty.
    const forbidden = ['NEEDS', 'YOU', 'REASONS'].join('_');
    const dir = path.resolve(__dirname, '../src');
    const offenders: string[] = [];
    const walk = (current: string): void => {
      for (const name of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, name.name);
        if (name.isDirectory()) walk(full);
        else if (name.name.endsWith('.ts') && fs.readFileSync(full, 'utf8').includes(forbidden)) {
          offenders.push(path.relative(dir, full));
        }
      }
    };
    walk(dir);
    expect(offenders).toEqual([]);
  });
});
