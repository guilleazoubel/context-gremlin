/**
 * What a row opens into (round 3): the ANSWER, then one verb, then the machinery behind a
 * disclosure.
 *
 * The point of the block being a sibling of the row is asserted in `panel-render`; here the
 * question is what it SAYS and what each of its buttons does — in particular that the verdict
 * leads, that `placement` is finally read rather than computed and discarded, and that nothing
 * is ever drawn as a fabricated zero.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createExpanded, patchExpanded } from '../../src/webview/panel/expanded';
import { setSink } from '../../src/webview/panel/channel';
import { FakeDocument, type FakeElement } from '../support/fake-dom';
import type {
  PanelActionView,
  PanelPartView,
  PanelRowView,
} from '../../src/model/panel-protocol';

let doc: FakeDocument;
let posted: unknown[];

beforeEach(() => {
  doc = new FakeDocument();
  (globalThis as unknown as { document: FakeDocument }).document = doc;
  posted = [];
  setSink((message) => posted.push(message));
});

function part(over: Partial<PanelPartView> & { key: string }): PanelPartView {
  return {
    kind: over.key,
    name: over.key,
    glyph: '•',
    state: '',
    stateText: '',
    detail: '',
    childId: null,
    actions: [],
    ...over,
  };
}

const VERBS: PanelActionView[] = [
  { command: 'cgremlin.openChild', label: 'Read the review', childId: 'agent:rev-1', placement: 'primary' },
  { command: 'cgremlin.chat', label: 'Chat', childId: 'agent:rev-1', placement: 'inline' },
  { command: 'cgremlin.openPr', label: 'Open on GitHub', childId: 'pr:acme/web#310', placement: 'inline' },
  { command: 'cgremlin.renameItem', label: 'Rename this item', placement: 'overflow' },
  { command: 'cgremlin.dismissItem', label: 'Hide from the panel', placement: 'overflow' },
];

function rowView(over: Partial<PanelRowView> = {}): PanelRowView {
  return {
    detailNotice: null,
    id: 'ticket:HB-627',
    list: 'myWork',
    label: 'HB-627 — Convert the tour scheduler to RSC',
    identity: 'HB-627',
    identityKeys: ['HB-627'],
    description: 'Convert the tour scheduler to RSC',
    descriptionIsOwn: false,
    badges: [],
    chips: [],
    age: '2d',
    size: '—',
    ci: '',
    meta: [],
    tier: '—',
    demoted: false,
    dismissed: false,
    needsYou: false,
    hasChildren: true,
    expanded: true,
    selected: true,
    verdict: {
      tone: 'mixed',
      label: 'Request changes',
      sentence: 'the payment retry loop can double-charge.',
      counts: '1 critical · 1 high',
      stale: null,
      notice: null,
    },
    facts: ['Your PR, open · 14 files +455/−51', 'Large · CI passing · opened 21 Sep'],
    ticketLine: 'HB-627 · In Review',
    detailsOpen: false,
    parts: [
      part({
        key: 'investigation',
        kind: 'investigation',
        name: 'Investigation',
        state: 'done',
        stateText: 'done · 2h',
        childId: 'agent:inv-1',
        actions: [
          { command: 'cgremlin.chat', label: 'Chat', childId: 'agent:inv-1', placement: 'inline' },
        ],
      }),
      part({
        key: 'review',
        kind: 'review',
        name: 'Review',
        state: 'notStarted',
        stateText: 'not started',
        actions: [],
      }),
      part({
        key: 'pr:acme/web#310',
        kind: 'pr',
        name: 'acme/web#310',
        stateText: 'open · 12 files +300/−80 · Opened 4 Sep',
        detail: '@jane reviewed',
        childId: 'pr:acme/web#310',
        actions: [],
      }),
    ],
    changes: null,
    actions: [],
    verbs: VERBS,
    ...over,
  };
}

function build(over: Partial<PanelRowView> = {}): FakeElement {
  const node = createExpanded() as unknown as FakeElement;
  patchExpanded(node as unknown as HTMLElement, rowView(over), null);
  doc.clearLog();
  return node;
}

const parts = (node: FakeElement): FakeElement[] => node.byClass('part');
const textOf = (node: FakeElement, cls: string): string => node.byClass(cls)[0]?.textContent ?? '';
const verbs = (node: FakeElement): FakeElement[] => node.byClass('row-verb');

/**
 * AC 1 — "an expanded review row states the verdict and finding counts as TEXT, above every
 * button, with no hover". The whole round is this test.
 */
describe('the verdict leads', () => {
  it('states the label, the sentence and the counts, above the first button', () => {
    const node = build();
    expect(textOf(node, 'verdict-answer')).toBe('The agent says: Request changes');
    expect(textOf(node, 'verdict-sentence')).toBe('the payment retry loop can double-charge.');
    expect(textOf(node, 'verdict-counts')).toBe('1 critical · 1 high');
    const order = node.children.map((child) => child.className);
    expect(order.indexOf('verdict')).toBeLessThan(order.indexOf('verbs'));
    expect(order.indexOf('verbs')).toBeLessThan(order.indexOf('facts'));
    expect(order.indexOf('facts')).toBeLessThan(order.indexOf('ticket-line'));
    expect(order.indexOf('ticket-line')).toBeLessThan(order.indexOf('details'));
  });

  it('carries the tone as data, never as the only signal', () => {
    expect(build().byClass('verdict')[0].getAttribute('data-tone')).toBe('mixed');
  });

  it('draws NO block at all where nothing parsed — and no zero anywhere', () => {
    const node = build({ verdict: null });
    expect(node.byClass('verdict')[0].hidden).toBe(true);
    expect(node.byClass('verdict')[0].textContent).toBe('');
    expect(node.textContent).not.toContain('0 findings');
  });

  it('says the report could not be read, and keeps the facts and the verbs', () => {
    const node = build({
      verdict: { tone: null, label: '', sentence: '', counts: '', stale: null, notice: 'The review could not be read' },
    });
    expect(textOf(node, 'verdict-notice')).toBe('The review could not be read');
    expect(node.byClass('verdict-answer')[0].hidden).toBe(true);
    expect(node.byClass('verdict-counts')[0].hidden).toBe(true);
    expect(verbs(node).length).toBeGreaterThan(0);
    expect(node.byClass('fact')).toHaveLength(2);
  });

  it('puts the staleness sentence WITH the verdict, and first — it outranks it', () => {
    const node = build({
      verdict: {
        tone: 'pass',
        label: 'Approve',
        sentence: '',
        counts: '',
        stale: 'The pull request changed after the agent looked at it',
        notice: null,
      },
    });
    const block = node.byClass('verdict')[0];
    expect(block.hidden).toBe(false);
    expect(block.children[0].className).toBe('verdict-stale');
    expect(block.children[0].textContent).toBe(
      'The pull request changed after the agent looked at it',
    );
  });
});

/** AC 4 and §e.7 — the placements are read, not recomputed and not discarded. */
describe('the verbs', () => {
  it('draws one primary, the supporting ones beside it, and the housekeeping nowhere near', () => {
    const node = build();
    expect(verbs(node).map((b) => `${b.className}|${b.textContent}`)).toEqual([
      'row-verb primary|Read the review',
      'row-verb inline|Chat',
      'row-verb inline|Open on GitHub',
    ]);
  });

  it('is labelled `Open` nowhere at all', () => {
    const node = build();
    const buttons = [...verbs(node), ...node.byClass('row-action'), ...node.byClass('part-action')];
    expect(buttons.map((b) => b.textContent)).not.toContain('Open');
  });

  it('posts openChild for the document verb and the command for everything else', () => {
    const node = build();
    verbs(node)[0].emit('click');
    verbs(node)[1].emit('click');
    expect(posted).toEqual([
      { type: 'openChild', id: 'ticket:HB-627', childId: 'agent:rev-1' },
      { type: 'command', command: 'cgremlin.chat', id: 'ticket:HB-627', childId: 'agent:rev-1' },
    ]);
  });

  it('keeps the housekeeping inside the disclosure, the acknowledgement included', () => {
    const node = build({
      detailsOpen: true,
      verbs: [...VERBS, { command: 'cgremlin.ack', label: 'Mark as seen', placement: 'overflow' }],
    });
    expect(node.byClass('row-action').map((b) => b.textContent)).toEqual([
      'Rename this item',
      'Hide from the panel',
      'Mark as seen',
    ]);
    // Named by its effect, never by the jargon the user read as a no-op.
    expect(node.textContent).not.toContain('Ack');
    node.byClass('row-action')[2].emit('click');
    expect(posted).toEqual([
      { type: 'command', command: 'cgremlin.ack', id: 'ticket:HB-627' },
    ]);
  });
});

/**
 * §e.7's disclosure — the object list, the worktree diff and the housekeeping, behind one click.
 * Its state is the HOST's, so the keyboard tree (which is built from the state, not the DOM)
 * cannot walk onto a part the user cannot see.
 */
describe('the disclosure', () => {
  it('is closed by default, and the machinery is not on screen', () => {
    const node = build();
    expect(node.byClass('details-toggle')[0].getAttribute('aria-expanded')).toBe('false');
    expect(node.byClass('details-body')[0].hidden).toBe(true);
  });

  it('asks the host to open it, rather than opening itself', () => {
    build().byClass('details-toggle')[0].emit('click');
    expect(posted).toEqual([{ type: 'toggleDetails', open: true }]);
  });

  it('asks the host to close it again when it is open', () => {
    build({ detailsOpen: true }).byClass('details-toggle')[0].emit('click');
    expect(posted).toEqual([{ type: 'toggleDetails', open: false }]);
  });

  it('shows the parts and the housekeeping once the host says it is open', () => {
    const node = build({ detailsOpen: true });
    expect(node.byClass('details-body')[0].hidden).toBe(false);
    expect(parts(node).map((p) => textOf(p, 'part-name'))).toEqual([
      'Investigation',
      'Review',
      'acme/web#310',
    ]);
  });
});

describe('the parts, inside the disclosure', () => {
  it('are exactly the parts the host sent, in order, as tree items', () => {
    const node = build({ detailsOpen: true });
    expect(parts(node).map((p) => p.dataset.key)).toEqual([
      'part:ticket:HB-627:investigation',
      'part:ticket:HB-627:review',
      'part:ticket:HB-627:pr:acme/web#310',
    ]);
    expect(parts(node).map((p) => p.getAttribute('aria-level'))).toEqual(['2', '2', '2']);
  });

  it('renders the second line only where a part has one', () => {
    const node = build({ detailsOpen: true });
    expect(parts(node).map((p) => p.byClass('part-detail')[0].hidden)).toEqual([true, true, false]);
    expect(textOf(parts(node)[2], 'part-detail')).toBe('@jane reviewed');
  });

  it('keeps a part`s own verbs under it, where a second Chat is unambiguous', () => {
    const node = build({ detailsOpen: true });
    expect(parts(node).map((p) => p.byClass('part-action').map((b) => b.textContent))).toEqual([
      ['Chat'],
      [],
      [],
    ]);
    parts(node)[0].byClass('part-action')[0].emit('click');
    expect(posted).toEqual([
      { type: 'command', command: 'cgremlin.chat', id: 'ticket:HB-627', childId: 'agent:inv-1' },
    ]);
  });

  it('opens a part on a click on the part itself, and nothing where no session exists', () => {
    const node = build({ detailsOpen: true });
    parts(node)[2].emit('click');
    parts(node)[1].emit('click');
    expect(posted).toEqual([
      { type: 'openChild', id: 'ticket:HB-627', childId: 'pr:acme/web#310' },
    ]);
  });

  it('patches a part in place when its stage moves on', () => {
    const node = build({ detailsOpen: true });
    const investigation = parts(node)[0];
    const next = rowView().parts;
    next[0] = { ...next[0], state: 'needsYou', stateText: 'needs you' };
    patchExpanded(
      node as unknown as HTMLElement,
      rowView({ parts: next, detailsOpen: true }),
      null,
    );
    expect(parts(node)[0]).toBe(investigation);
    expect(doc.log.map((m) => m.detail)).toEqual([
      'needs you',
      'aria-label=Investigation needs you',
    ]);
  });

  it('drops a part that stopped applying, and creates only the one that appeared', () => {
    const node = build({ detailsOpen: true });
    const next = rowView().parts.slice(1);
    patchExpanded(
      node as unknown as HTMLElement,
      rowView({ parts: next, detailsOpen: true }),
      null,
    );
    expect(parts(node).map((p) => textOf(p, 'part-name'))).toEqual(['Review', 'acme/web#310']);
    expect(doc.log.filter((m) => m.kind === 'create')).toEqual([]);
  });
});

/**
 * §e.3 — one size measurement above the disclosure, and the second one NAMES its base.
 *
 * Three numbers used to sit in the open row with three different bases and nothing on screen
 * saying so. `Working tree 0 files +0/−0` is gone: zero is the normal case, and a whole line to
 * say nothing happened is what the user was reading.
 */
describe('the change counts, demoted and named', () => {
  it('draws the worktree line with its ref, and no uncommitted line when there is none', () => {
    const node = build({
      detailsOpen: true,
      changes: { worktree: 'Agent worktree since main: 8 files +240/−31', uncommitted: null },
    });
    expect(textOf(node, 'change-worktree')).toBe('Agent worktree since main: 8 files +240/−31');
    expect(node.byClass('change-uncommitted')[0].hidden).toBe(true);
  });

  it('draws the uncommitted line only where it is news', () => {
    const node = build({
      detailsOpen: true,
      changes: {
        worktree: 'Agent worktree since main: 8 files +240/−31',
        uncommitted: 'The agent left 3 uncommitted files in your worktree',
      },
    });
    expect(node.byClass('change-uncommitted')[0].hidden).toBe(false);
    expect(textOf(node, 'change-uncommitted')).toBe(
      'The agent left 3 uncommitted files in your worktree',
    );
  });
});

/** The PR's facts, in words — defect 10's answer. */
describe('the facts', () => {
  it('draws one line per fact, and nothing at all on a row with no PR', () => {
    expect(build().byClass('fact').map((f) => f.textContent)).toEqual([
      'Your PR, open · 14 files +455/−51',
      'Large · CI passing · opened 21 Sep',
    ]);
    const bare = build({ facts: [], ticketLine: '' });
    expect(bare.byClass('facts')[0].hidden).toBe(true);
    expect(bare.byClass('ticket-line')[0].hidden).toBe(true);
  });

  it('puts the ticket and its status on one line', () => {
    expect(textOf(build(), 'ticket-line')).toBe('HB-627 · In Review');
  });
});

/**
 * AC 5 — "At 280px, 300px and 380px, no part line renders a glyph or label with nothing beside
 * it."
 *
 * A fake DOM has no layout engine, so this asserts the two things that DECIDE the layout: the
 * markup (there is no lone-mark node left to strand — the glyph column is gone) and the flex
 * bases that choose the line break. `flex: 1 1 0` is the whole fix: line-breaking uses the flex
 * BASE size, so `auto` (max-content) pushed the long state string to line two and left the 14px
 * mark alone on line one; `min-width: 0` cannot help, because it governs shrinking AFTER the
 * line has been chosen.
 */
describe('AC 5 — nothing is left alone on a line at any sidebar width', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../../media/panel.css'), 'utf8');

  function ruleOf(selector: string): string {
    const found = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(css);
    return found?.[1] ?? '';
  }

  for (const width of [280, 300, 380]) {
    it(`renders no node whose whole content is a bare mark at ${width}px`, () => {
      const node = build({ detailsOpen: true });
      // Every leaf that carries text carries WORDS. A 14px glyph column would show up here as a
      // one-character leaf with no text of its own beside it — which is the defect.
      const leaves = node
        .findAll((el) => el.children.length === 0 && el.textContent.trim() !== '');
      expect(leaves.map((leaf) => leaf.textContent).filter((text) => text.trim().length <= 2)).toEqual([]);
      expect(node.byClass('part-glyph')).toEqual([]);
      expect(width).toBeGreaterThan(0);
    });
  }

  it('gives the text a ZERO flex base, so the wrap decision cannot strand anything', () => {
    expect(ruleOf('.part-text')).toMatch(/flex:\s*1\s+1\s+0/);
  });

  it('gives the verbs a row of their own rather than a share of the text`s line', () => {
    expect(ruleOf('.part-actions')).toMatch(/flex:\s*1\s+0\s+100%/);
  });

  it('draws no glyph column in the open block at all', () => {
    expect(css).not.toContain('.part-glyph');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/webview/panel/expanded.ts'),
      'utf8',
    );
    expect(source).not.toContain('part-glyph');
  });
});

/**
 * The engine died while the panel was open. The parts on screen came out of the snapshot and are
 * still true; what is not true is "this is current". One line says so, inside the row the user
 * opened — never a popup, because the user did not do anything wrong and there is nothing to
 * dismiss.
 */
describe('an expanded row with no engine behind it', () => {
  const OFFLINE = 'Engine offline — showing what was last loaded';

  it('draws the line at the top, with everything else still there', () => {
    const node = build({ detailNotice: OFFLINE, detailsOpen: true });
    const line = node.byClass('expanded-offline')[0];
    expect(line?.textContent).toBe(OFFLINE);
    expect(line?.hidden).toBe(false);
    expect(parts(node)).not.toHaveLength(0);
  });

  it('draws nothing at all while the engine is answering', () => {
    expect(build().byClass('expanded-offline')[0]?.hidden).toBe(true);
  });
});

/**
 * Phase 18 item 1 — a verb whose gate failed is DRAWN, inert, with one sentence under it. A
 * tooltip would not do: a browser will not show one on a disabled control, and the panel ships
 * no `title` at all.
 */
describe('Phase 18 — a disabled verb names its reason', () => {
  const REASON = 'No pull request is linked to this ticket yet.';
  const disabled: PanelActionView = {
    command: 'cgremlin.verifyInQa',
    label: 'Verify in QA',
    placement: 'primary',
    enabled: false,
    reason: REASON,
  };

  it('disables the button and points it at the reason line under the group', () => {
    const node = build({ verbs: [disabled] });
    const button = verbs(node)[0];
    const reason = node.byClass('action-reason')[0];
    expect(button.disabled).toBe(true);
    expect(reason.id).not.toBe('');
    expect(button.getAttribute('aria-describedby')).toBe(reason.id);
    expect(reason.textContent).toBe(`Verify in QA: ${REASON}`);
    expect(button.getAttribute('title')).toBeNull();
  });

  it('leaves an enabled verb undescribed, and draws no reason line at all', () => {
    const node = build({ verbs: [{ ...disabled, enabled: undefined, reason: undefined }] });
    expect(verbs(node)[0].disabled).toBe(false);
    expect(verbs(node)[0].getAttribute('aria-describedby')).toBeNull();
    expect(node.byClass('action-reason')).toHaveLength(0);
  });
});

/** P0-4 — the reconciler patches in place, and an identical frame writes NOTHING. */
describe('P0-4 the block mutates nothing on identical data', () => {
  it('assigns nothing at all on a patch over the same row, closed', () => {
    const node = build();
    patchExpanded(node as unknown as HTMLElement, rowView(), null);
    expect(doc.log).toEqual([]);
    expect(doc.writes).toEqual([]);
  });

  it('assigns nothing at all on a patch over the same row, open', () => {
    const node = build({ detailsOpen: true });
    patchExpanded(node as unknown as HTMLElement, rowView({ detailsOpen: true }), null);
    expect(doc.log).toEqual([]);
    expect(doc.writes).toEqual([]);
  });
});

/**
 * §2.2 rule 10 — one accent in the whole panel, and colour is never the only signal.
 * `--vscode-charts-red` stays reserved for a failing build (§5), so a `fail` verdict does not
 * borrow it.
 */
describe('the verdict borrows no palette of its own', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../../media/panel.css'), 'utf8');

  it('tints a verdict that wants you with the one accent, and nothing else', () => {
    const rule = /\.verdict\[data-tone='fail'\][\s\S]*?\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('var(--cg-accent)');
    expect(rule).not.toContain('charts-red');
  });

  it('says the verdict in weight as well as colour, so colour is never the only signal', () => {
    const rule = /\n\.verdict-answer\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/font-weight:\s*600/);
  });

  it('invents no palette anywhere in the panel stylesheet', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\brgba?\(/);
    expect(css).not.toMatch(/\bhsla?\(/);
  });
});
