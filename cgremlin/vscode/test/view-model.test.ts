import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildLists,
  indicatorFor,
  isTerminalPhase,
  LIST_ORDER,
  TERMINAL_PHASES_BY_MODE,
  type ListDescriptor,
  type ViewModelInput,
} from '../src/model/view-model';
import type { AttentionItem, AttentionReason, ListKind } from '../src/model/items';
import { fixtures } from './support/stub-server';

const attention = fixtures.attention as { items: AttentionItem[] };
const prs = fixtures.prs as {
  inventory: { entries: { repo: string; number: number }[] };
  groups: ViewModelInput['groups'];
};
const sessions = fixtures.sessions as { sessions: ViewModelInput['sessions'] };

function input(overrides: Partial<ViewModelInput> = {}): ViewModelInput {
  return {
    items: attention.items,
    groups: prs.groups,
    sessions: sessions.sessions,
    ...overrides,
  };
}

const refs = (items: { item: AttentionItem }[]): string[] => items.map((l) => l.item.ref);

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    source: 'session',
    ref: 'session:s1',
    id: 's1',
    title: 'A session',
    repoOrContext: 'acme/web',
    attention: {
      needsAttention: false,
      needsYou: false,
      reasons: [],
      since: '2026-09-10T08:00:00.000Z',
      signature: '|2026-09-10T08:00:00.000Z',
      acked: false,
    },
    links: {
      sessionId: 's1',
      worktreePath: '/tmp/wt/s1',
      prRepo: null,
      prNumber: null,
      prUrl: null,
      ticket: null,
      primaryArtifact: null,
    },
    mode: 'investigation',
    stageStatus: 'findings',
    running: false,
    claimed: false,
    ...overrides,
  };
}

const withReasons = (reasons: AttentionReason[], overrides: Partial<AttentionItem> = {}): AttentionItem =>
  item({
    ...overrides,
    attention: {
      needsAttention: reasons.length > 0,
      needsYou: reasons.length > 0,
      reasons,
      since: '2026-09-10T08:00:00.000Z',
      signature: `${reasons.join(',')}|2026-09-10T08:00:00.000Z`,
      acked: false,
    },
  });

describe('buildLists over the committed fixtures', () => {
  it('makes parking exactly the unreviewed group', () => {
    const lists = buildLists(input());
    expect(refs(lists.parking)).toEqual(['pr:acme/web#101']);
  });

  it('holds every non-terminal review session in reviewing, enriched when the inventory knows it', () => {
    const lists = buildLists(input());
    expect(refs(lists.reviewing)).toEqual(['session:pr-acme-web-102', 'session:pr-offcfg-lab-55']);
    const tracked = lists.reviewing[0];
    const offConfig = lists.reviewing[1];
    expect(tracked?.description).toContain('new commits');
    expect(offConfig?.description).not.toContain('new commits');
  });

  it('holds every non-terminal investigation and no terminal one', () => {
    const lists = buildLists(input());
    expect(refs(lists.investigations)).toEqual(['session:inv-acme-web-7f3']);
  });

  it('holds every non-terminal development session plus each of my PRs with no development session', () => {
    const lists = buildLists(input());
    // dev-acme-api-7 covers acme/api#7, so that `groups.mine` entry gets no second row;
    // acme/web#103 has no development session and therefore does.
    expect(refs(lists.devwork)).toEqual(['session:dev-acme-api-7', 'pr:acme/web#103']);
    expect(refs(lists.devwork)).not.toContain('pr:acme/api#7');
    expect(refs(lists.devwork)).not.toContain('session:dev-acme-web-done');
  });

  it('carries the attention item verbatim and a contextValue keyed by kind, source and mode', () => {
    const lists = buildLists(input());
    const row = lists.reviewing[0];
    expect(row?.item).toBe(attention.items.find((i) => i.ref === 'session:pr-acme-web-102'));
    expect(row?.contextValue).toBe('reviewing:session:review');
    expect(lists.parking[0]?.contextValue).toBe('parking:pr:none');
  });
});

describe('MG-B6 off-config-review-is-visible', () => {
  it('shows a review session whose PR matches no inventory entry', () => {
    const known = prs.inventory.entries.map((e) => `${e.repo}#${e.number}`);
    expect(known).not.toContain('offcfg/lab#55');
    const lists = buildLists(input());
    expect(refs(lists.reviewing)).toContain('session:pr-offcfg-lab-55');
  });

  it('still builds the session-sourced lists before the first scan', () => {
    const lists = buildLists(input({ groups: null }));
    expect(lists.parking).toEqual([]);
    expect(refs(lists.reviewing)).toEqual(['session:pr-acme-web-102', 'session:pr-offcfg-lab-55']);
    expect(refs(lists.investigations)).toEqual(['session:inv-acme-web-7f3']);
    expect(refs(lists.devwork)).toEqual(['session:dev-acme-api-7']);
  });

  it('never branches a build function on the item source', () => {
    const dir = path.resolve(__dirname, '../src/model');
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.ts')) continue;
      const source = fs.readFileSync(path.join(dir, name), 'utf8');
      expect(source).not.toContain('switch (item.source');
      expect(source).not.toContain('if (item.source ===');
      expect(source).not.toContain('item.source ===');
    }
  });
});

describe('R18 — the list array is the extension point', () => {
  it('returns exactly the kinds LIST_ORDER declares', () => {
    const lists = buildLists(input());
    expect(Object.keys(lists)).toEqual(LIST_ORDER.map((d) => d.kind));
  });

  it('grows a fifth list from a stub descriptor with no other edit', () => {
    const stubItem = item({ ref: 'jira:ING-9', id: 'ING-9', source: 'jira' as never });
    const stub: ListDescriptor = {
      kind: 'tickets' as unknown as ListKind,
      title: 'Tickets',
      build: () => [
        {
          kind: 'tickets' as unknown as ListKind,
          item: stubItem,
          label: 'ING-9',
          description: '',
          indicator: '' as const,
          contextValue: 'tickets:jira:none',
        },
      ],
    };
    const baseline = buildLists(input());
    const extended = buildLists(input(), [...LIST_ORDER, stub]);
    expect(Object.keys(extended)).toEqual([...LIST_ORDER.map((d) => d.kind), 'tickets']);
    for (const descriptor of LIST_ORDER) {
      expect(refs(extended[descriptor.kind])).toEqual(refs(baseline[descriptor.kind]));
    }
  });

  it('drops an item of an unknown source into no list, without throwing', () => {
    const unknown = item({ ref: 'jira:ING-9', id: 'ING-9', source: 'jira' as never, mode: null, stageStatus: null });
    const lists = buildLists(input({ items: [...attention.items, unknown] }));
    for (const descriptor of LIST_ORDER) {
      expect(refs(lists[descriptor.kind])).not.toContain('jira:ING-9');
    }
  });
});

describe('indicator precedence', () => {
  it('prefers a claim over everything', () => {
    expect(indicatorFor(withReasons(['blocked'], { claimed: true, running: true }))).toBe('👤');
  });

  it('prefers a live run over a gate', () => {
    expect(indicatorFor(withReasons(['needs_input'], { running: true }))).toBe('🔄');
  });

  it('ranks blocked, run_failed, needs_input and the ready gates in that order', () => {
    expect(indicatorFor(withReasons(['blocked']))).toBe('🛑');
    expect(indicatorFor(withReasons(['run_failed']))).toBe('❗');
    expect(indicatorFor(withReasons(['needs_input']))).toBe('⏸️');
    expect(indicatorFor(withReasons(['plan_ready']))).toBe('✅');
    expect(indicatorFor(withReasons(['review_ready']))).toBe('✅');
    expect(indicatorFor(withReasons(['rereview_ready']))).toBe('✅');
    expect(indicatorFor(withReasons(['changes_requested']))).toBe('✅');
  });

  it('shows nothing when nothing is happening', () => {
    expect(indicatorFor(item())).toBe('');
    expect(indicatorFor(withReasons(['local_prereq_failed']))).toBe('');
  });
});

describe('the mirrored terminal-phase table', () => {
  /**
   * The core owns terminality; this pins the mirror against the core's own literal, parsed out of
   * its source. `changes_requested` is deliberately NOT terminal — the core's review table lets it
   * transition back to `reviewing`, which is exactly how a re-review reaches a PR that asked for
   * changes.
   */
  it('equals the core TERMINAL_PHASES_BY_MODE literal', () => {
    const coreSource = fs.readFileSync(
      path.resolve(__dirname, '../../core/src/workspace/workspace-in-use.ts'),
      'utf8',
    );
    const block = /TERMINAL_PHASES_BY_MODE[^=]*=\s*\{([\s\S]*?)\n\};/.exec(coreSource);
    expect(block).not.toBeNull();
    const parsed: Record<string, string[]> = {};
    const entry = /(\w+):\s*new Set\(\[([^\]]*)\]\)/g;
    let match: RegExpExecArray | null;
    while ((match = entry.exec(block?.[1] ?? '')) !== null) {
      parsed[match[1]] = [...match[2].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    }
    expect(Object.keys(parsed).sort()).toEqual(['development', 'investigation', 'review']);
    for (const [mode, phases] of Object.entries(parsed)) {
      expect([...TERMINAL_PHASES_BY_MODE[mode as keyof typeof TERMINAL_PHASES_BY_MODE]].sort()).toEqual(
        [...phases].sort(),
      );
    }
  });

  it('treats the terminal phases as terminal and the live ones as live', () => {
    expect(isTerminalPhase('investigation', 'promoted_to_development')).toBe(true);
    expect(isTerminalPhase('investigation', 'abandoned')).toBe(true);
    expect(isTerminalPhase('development', 'merged')).toBe(true);
    expect(isTerminalPhase('development', 'abandoned')).toBe(true);
    expect(isTerminalPhase('review', 'approved')).toBe(true);
    expect(isTerminalPhase('review', 'dismissed')).toBe(true);

    expect(isTerminalPhase('investigation', 'plan_ready')).toBe(false);
    expect(isTerminalPhase('development', 'active')).toBe(false);
    expect(isTerminalPhase('review', 'ready')).toBe(false);
    expect(isTerminalPhase('review', 'changes_requested')).toBe(false);
    expect(isTerminalPhase(null, null)).toBe(false);
  });
});
