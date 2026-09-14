/**
 * What a row opens into: three slots, the parts, and the size of the change.
 *
 * The point of the block being a sibling of the row is asserted in `panel-render`; here the
 * question is what it says and what each of its buttons does — in particular that a slot never
 * offers Open or Chat for a stage that never ran, and that "Start" is only ever the verb the
 * host put on that slot.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createExpanded, patchExpanded } from '../../src/webview/panel/expanded';
import { setSink } from '../../src/webview/panel/channel';
import { FakeDocument, type FakeElement } from '../support/fake-dom';
import type { PanelActionView, PanelRowView, PanelSlotView } from '../../src/model/panel-protocol';

let doc: FakeDocument;
let posted: unknown[];

beforeEach(() => {
  doc = new FakeDocument();
  (globalThis as unknown as { document: FakeDocument }).document = doc;
  posted = [];
  setSink((message) => posted.push(message));
});

function slot(over: Partial<PanelSlotView> & { stage: PanelSlotView['stage'] }): PanelSlotView {
  return {
    title: over.stage,
    glyph: '•',
    state: 'notStarted',
    stateText: 'not started',
    sessionId: null,
    start: null,
    ...over,
  };
}

function rowView(over: Partial<PanelRowView> = {}): PanelRowView {
  return {
    hint: null,
    id: 'ticket:HB-627',
    list: 'myWork',
    label: 'HB-627 — Convert the tour scheduler to RSC',
    description: '',
    badges: [],
    chips: [],
    age: '2d',
    size: '—',
    ci: '',
    meta: [],
    stateLine: [],
    tier: '—',
    demoted: false,
    needsYou: false,
    hasChildren: true,
    expanded: true,
    selected: true,
    children: [
      { id: 'ticket:HB-627', kind: 'ticket', label: '🎫 HB-627 (In Progress)', goToLabel: 'Open in Jira' },
      { id: 'pr:acme/web#310', kind: 'pr', label: '🔀 acme/web#310 — open', goToLabel: 'Open on GitHub' },
    ],
    lifecycle: [
      slot({ stage: 'investigation', title: 'Investigation', state: 'done', stateText: 'done · 2h', sessionId: 'inv-1' }),
      slot({ stage: 'development', title: 'Development', state: 'running', stateText: 'running · coding', sessionId: 'dev-1' }),
      slot({
        stage: 'review',
        title: 'Review',
        start: { command: 'cgremlin.startReview', label: 'Start self-review', placement: 'primary' },
      }),
    ],
    changes: null,
    actions: [],
    people: [],
    ...over,
  };
}

function build(over: Partial<PanelRowView> = {}): FakeElement {
  const node = createExpanded() as unknown as FakeElement;
  patchExpanded(node as unknown as HTMLElement, rowView(over), null);
  doc.clearLog();
  return node;
}

const slots = (node: FakeElement): FakeElement[] => node.byClass('slot');
const textOf = (node: FakeElement, cls: string): string => node.byClass(cls)[0]?.textContent ?? '';

describe('the lifecycle slots', () => {
  it('assign nothing at all on a patch over identical data', () => {
    const node = build();
    patchExpanded(node as unknown as HTMLElement, rowView(), null);
    expect(doc.log).toEqual([]);
    expect(doc.writes).toEqual([]);
  });

  it('are the three stages with their states, in order', () => {
    const node = build();
    expect(slots(node).map((s) => textOf(s, 'slot-title'))).toEqual([
      'Investigation',
      'Development',
      'Review',
    ]);
    expect(slots(node).map((s) => textOf(s, 'slot-state'))).toEqual([
      'done · 2h',
      'running · coding',
      'not started',
    ]);
  });

  it('offers Open and Chat only where a session exists', () => {
    const node = build();
    expect(slots(node).map((s) => s.byClass('slot-open')[0].hidden)).toEqual([false, false, true]);
    expect(slots(node).map((s) => s.byClass('slot-chat')[0].hidden)).toEqual([false, false, true]);
  });

  it('shows a Start on the one slot the host put one on, with the host’s own wording', () => {
    const node = build();
    expect(slots(node).map((s) => s.byClass('slot-start')[0].hidden)).toEqual([true, true, false]);
    expect(textOf(slots(node)[2], 'slot-start')).toBe('Start self-review');
  });

  it('opens the item tab on that agent, and chats to that agent', () => {
    const node = build();
    slots(node)[1].byClass('slot-open')[0].emit('click');
    slots(node)[1].byClass('slot-chat')[0].emit('click');
    slots(node)[2].byClass('slot-start')[0].emit('click');
    expect(posted).toEqual([
      { type: 'openChild', id: 'ticket:HB-627', childId: 'agent:dev-1' },
      { type: 'command', command: 'cgremlin.chat', id: 'ticket:HB-627', childId: 'agent:dev-1' },
      { type: 'command', command: 'cgremlin.startReview', id: 'ticket:HB-627' },
    ]);
  });

  it('patches a slot in place when its stage moves on', () => {
    const node = build();
    const development = slots(node)[1];
    const lifecycle = rowView().lifecycle;
    lifecycle[1] = { ...lifecycle[1], state: 'needsYou', stateText: 'needs you · plan_ready' };
    patchExpanded(node as unknown as HTMLElement, rowView({ lifecycle }), null);
    expect(slots(node)[1]).toBe(development);
    expect(doc.log.map((m) => m.detail)).toEqual(['needs you · plan_ready']);
  });
});

describe('the parts and the change counts', () => {
  it('lists the ticket and the PRs as tree items, and no agent among them', () => {
    const node = build();
    const parts = node.byClass('part');
    expect(parts.map((part) => part.getAttribute('aria-level'))).toEqual(['2', '2']);
    expect(parts.map((part) => textOf(part, 'part-goto'))).toEqual([
      'Open in Jira',
      'Open on GitHub',
    ]);
  });

  it('opens a part in the item tab, and its Go-to in the browser', () => {
    const node = build();
    node.byClass('part')[1].emit('click');
    node.byClass('part')[0].byClass('part-goto')[0].emit('click');
    expect(posted).toEqual([
      { type: 'openChild', id: 'ticket:HB-627', childId: 'pr:acme/web#310' },
      { type: 'command', command: 'cgremlin.openTicket', id: 'ticket:HB-627', childId: 'ticket:HB-627' },
    ]);
  });

  it('says `—` for a change the engine has not reported, and never a zero', () => {
    const node = build();
    expect(textOf(node, 'committed-value')).toBe('—');
    expect(textOf(node, 'working-value')).toBe('—');
  });

  it('writes the counts once they arrive, and nothing else', () => {
    const node = build();
    patchExpanded(
      node as unknown as HTMLElement,
      rowView({ changes: { committed: '8 files +240/−31', workingTree: '2 files +12/−0' } }),
      null,
    );
    expect(doc.log.map((m) => m.detail)).toEqual(['8 files +240/−31', '2 files +12/−0']);
  });
});

/**
 * P10 — the row's gutter and its `⋯` popover are gone, so the expanded block is the ONLY place a
 * verb lives. Which means it has to carry every verb: the ones the slots already offer, and the
 * rare ones that have nowhere else to go — Ack, Open on GitHub, Open in Jira.
 */
const ACTIONS: PanelActionView[] = [
  { command: 'cgremlin.startReview', label: 'Start self-review', placement: 'primary' },
  { command: 'cgremlin.chat', label: 'Chat', childId: 'agent:dev-1', placement: 'inline' },
  {
    command: 'cgremlin.openPr',
    label: 'Open acme/web#310',
    childId: 'pr:acme/web#310',
    placement: 'overflow',
  },
  {
    command: 'cgremlin.openTicket',
    label: 'Open HB-627',
    childId: 'ticket:HB-627',
    placement: 'overflow',
  },
  { command: 'cgremlin.ack', label: 'Ack', placement: 'overflow' },
];

describe('the action line', () => {
  it('exposes every action the row has, once, between the line and the slots', () => {
    const node = build({ actions: ACTIONS });
    // The rare ones, in the line.
    expect(node.byClass('row-action').map((b) => b.textContent)).toEqual([
      'Open acme/web#310',
      'Open HB-627',
      'Ack',
    ]);
    // The other two are already verbs on the slots that own them — never said twice.
    expect(textOf(slots(node)[2], 'slot-start')).toBe('Start self-review');
    expect(slots(node)[1].byClass('slot-chat')[0].hidden).toBe(false);
  });

  it('posts the action it was clicked with, naming the part it is about', () => {
    const node = build({ actions: ACTIONS });
    node.byClass('row-action')[0].emit('click');
    node.byClass('row-action')[2].emit('click');
    expect(posted).toEqual([
      {
        type: 'command',
        command: 'cgremlin.openPr',
        id: 'ticket:HB-627',
        childId: 'pr:acme/web#310',
      },
      { type: 'command', command: 'cgremlin.ack', id: 'ticket:HB-627' },
    ]);
  });

  it('hides the line entirely when the slots already say everything', () => {
    const node = build({ actions: [ACTIONS[0], ACTIONS[1]] });
    expect(node.byClass('row-action')).toEqual([]);
    expect(node.byClass('actions')[0].hidden).toBe(true);
  });

  it('assigns nothing on a patch over identical actions', () => {
    const node = build({ actions: ACTIONS });
    patchExpanded(node as unknown as HTMLElement, rowView({ actions: ACTIONS }), null);
    expect(doc.log).toEqual([]);
    expect(doc.writes).toEqual([]);
  });
});

/**
 * "Someone is on it" is the group the user cannot act on without knowing WHO and WHEN. The
 * collapsed row carries the strongest one; the open row carries all of them.
 */
describe('who has been on it', () => {
  const PEOPLE = [
    { login: 'jane', kind: 'reviewed' as const, verdict: 'approved', age: '2d ago' },
    { login: 'DavidAPFM', kind: 'commented' as const, verdict: null, age: '2d ago' },
  ];

  it('lists every interaction as login, kind and age', () => {
    const node = build({ people: PEOPLE });
    expect(node.byClass('person').map((p) => p.textContent)).toEqual([
      '@jane · reviewed (approved) · 2d ago',
      '@DavidAPFM · commented · 2d ago',
    ]);
  });

  it('hides the block entirely when no human has touched it', () => {
    const node = build();
    expect(node.byClass('person')).toEqual([]);
    expect(node.byClass('people')[0].hidden).toBe(true);
  });

  it('assigns nothing on a patch over the same people', () => {
    const node = build({ people: PEOPLE });
    patchExpanded(node as unknown as HTMLElement, rowView({ people: PEOPLE }), null);
    expect(doc.log).toEqual([]);
    expect(doc.writes).toEqual([]);
  });
});
