/**
 * What a row opens into: the item's parts, and the size of the change (§4).
 *
 * The point of the block being a sibling of the row is asserted in `panel-render`; here the
 * question is what it says and what each of its buttons does — in particular that a part never
 * offers Open for a stage that never ran, and that a Start is only ever the verb the host put on
 * that part.
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

const OPEN = (childId: string): PanelActionView => ({
  command: 'cgremlin.openChild',
  label: 'Open',
  childId,
  placement: 'inline',
});

function rowView(over: Partial<PanelRowView> = {}): PanelRowView {
  return {
    hint: null,
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
    parts: [
      part({
        key: 'investigation',
        kind: 'investigation',
        name: 'Investigation',
        state: 'done',
        stateText: 'done · 2h',
        childId: 'agent:inv-1',
        actions: [
          OPEN('agent:inv-1'),
          { command: 'cgremlin.chat', label: 'Chat', childId: 'agent:inv-1', placement: 'inline' },
        ],
      }),
      part({
        key: 'review',
        kind: 'review',
        name: 'Review',
        state: 'notStarted',
        stateText: 'not started',
        actions: [
          { command: 'cgremlin.startReview', label: 'Start self-review', placement: 'primary' },
        ],
      }),
      part({
        key: 'pr:acme/web#310',
        kind: 'pr',
        name: 'acme/web#310',
        stateText: 'open · 12 files +300/−80 · Opened 4 Sep',
        detail: '@jane reviewed',
        childId: 'pr:acme/web#310',
        actions: [
          OPEN('pr:acme/web#310'),
          {
            command: 'cgremlin.openPr',
            label: 'Open on GitHub',
            childId: 'pr:acme/web#310',
            placement: 'inline',
          },
        ],
      }),
    ],
    changes: null,
    actions: [],
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
const labels = (node: FakeElement): string[] =>
  node.byClass('part-action').map((b) => b.textContent);

describe('§4 the parts', () => {
  it('assign nothing at all on a patch over identical data', () => {
    const node = build();
    patchExpanded(node as unknown as HTMLElement, rowView(), null);
    expect(doc.log).toEqual([]);
    expect(doc.writes).toEqual([]);
  });

  it('are exactly the parts the host sent, in order, as tree items', () => {
    const node = build();
    expect(parts(node).map((p) => p.dataset.key)).toEqual([
      'part:ticket:HB-627:investigation',
      'part:ticket:HB-627:review',
      'part:ticket:HB-627:pr:acme/web#310',
    ]);
    expect(parts(node).map((p) => p.getAttribute('aria-level'))).toEqual(['2', '2', '2']);
    expect(parts(node).map((p) => textOf(p, 'part-name'))).toEqual([
      'Investigation',
      'Review',
      'acme/web#310',
    ]);
    expect(parts(node).map((p) => textOf(p, 'part-state'))).toEqual([
      'done · 2h',
      'not started',
      'open · 12 files +300/−80 · Opened 4 Sep',
    ]);
  });

  it('renders the second line only where a part has one', () => {
    const node = build();
    expect(parts(node).map((p) => p.byClass('part-detail')[0].hidden)).toEqual([true, true, false]);
    expect(textOf(parts(node)[2], 'part-detail')).toBe('@jane reviewed');
  });

  it('shows each part exactly the buttons the host put on it, and no others', () => {
    const node = build();
    expect(parts(node).map((p) => p.byClass('part-action').map((b) => b.textContent))).toEqual([
      ['Open', 'Chat'],
      ['Start self-review'],
      ['Open', 'Open on GitHub'],
    ]);
  });

  it('opens the item tab on that part, chats to that agent, and starts with the host’s verb', () => {
    const node = build();
    parts(node)[0].byClass('part-action')[0].emit('click');
    parts(node)[0].byClass('part-action')[1].emit('click');
    parts(node)[1].byClass('part-action')[0].emit('click');
    expect(posted).toEqual([
      { type: 'openChild', id: 'ticket:HB-627', childId: 'agent:inv-1' },
      { type: 'command', command: 'cgremlin.chat', id: 'ticket:HB-627', childId: 'agent:inv-1' },
      { type: 'command', command: 'cgremlin.startReview', id: 'ticket:HB-627' },
    ]);
  });

  it('opens a part on a click on the part itself, and nothing where no session exists', () => {
    const node = build();
    parts(node)[2].emit('click');
    parts(node)[1].emit('click');
    expect(posted).toEqual([
      { type: 'openChild', id: 'ticket:HB-627', childId: 'pr:acme/web#310' },
    ]);
  });

  it('patches a part in place when its stage moves on', () => {
    const node = build();
    const investigation = parts(node)[0];
    const next = rowView().parts;
    next[0] = { ...next[0], state: 'needsYou', stateText: 'needs you · plan_ready' };
    patchExpanded(node as unknown as HTMLElement, rowView({ parts: next }), null);
    expect(parts(node)[0]).toBe(investigation);
    expect(doc.log.map((m) => m.detail)).toEqual([
      'needs you · plan_ready',
      'aria-label=Investigation needs you · plan_ready',
    ]);
  });

  it('drops a part that stopped applying, and creates only the one that appeared', () => {
    const node = build();
    const next = rowView().parts.slice(1);
    patchExpanded(node as unknown as HTMLElement, rowView({ parts: next }), null);
    expect(parts(node).map((p) => textOf(p, 'part-name'))).toEqual(['Review', 'acme/web#310']);
    expect(doc.log.filter((m) => m.kind === 'create')).toEqual([]);
  });
});

describe('§4 the change counts and the one leftover verb', () => {
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

  it('leaves only what no part already offers — which is Ack', () => {
    const node = build({
      actions: [
        { command: 'cgremlin.startReview', label: 'Start self-review', placement: 'primary' },
        { command: 'cgremlin.chat', label: 'Chat', childId: 'agent:inv-1', placement: 'inline' },
        {
          command: 'cgremlin.openPr',
          label: 'Open acme/web#310',
          childId: 'pr:acme/web#310',
          placement: 'overflow',
        },
        { command: 'cgremlin.ack', label: 'Ack', placement: 'overflow' },
      ],
    });
    expect(node.byClass('row-action').map((b) => b.textContent)).toEqual(['Ack']);
    node.byClass('row-action')[0].emit('click');
    expect(posted).toEqual([{ type: 'command', command: 'cgremlin.ack', id: 'ticket:HB-627' }]);
  });

  it('hides the line entirely when the parts already say everything', () => {
    const node = build({ actions: [] });
    expect(node.byClass('row-action')).toEqual([]);
    expect(node.byClass('actions')[0].hidden).toBe(true);
  });
});

describe('§4 nothing is said twice', () => {
  it('renders no lifecycle spine, no people block and no go-to column', () => {
    const node = build();
    expect(node.byClass('slot')).toEqual([]);
    expect(node.byClass('people')).toEqual([]);
    expect(node.byClass('part-goto')).toEqual([]);
    expect(labels(node)).toHaveLength(5);
  });
});

describe('§4 a part that opens nothing is not a pointer target', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../../media/panel.css'), 'utf8');

  it('marks a stage with no session as such, and drops the hand over it', () => {
    const node = build();
    expect(parts(node).map((p) => p.dataset.childId)).toEqual([
      'agent:inv-1',
      '',
      'pr:acme/web#310',
    ]);
    expect(css).toMatch(/\.part\[data-child-id=''\]\s*\{[^}]*cursor:\s*default/);
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

  it('draws the line under the hint, with the parts still there', () => {
    const node = build({ detailNotice: OFFLINE });
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
 * Phase 18 item 1 — a verb whose gate failed is DRAWN, inert, with one sentence under it.
 *
 * The defect it replaces is silence: `Verify in QA` simply was not there on three of the user's
 * four QA tickets. A tooltip would not fix that (a browser will not show one on a disabled
 * control, and the panel ships no `title` at all), so the reason is ink and the button points at
 * it with `aria-describedby`.
 */
describe('Phase 18 — a disabled part verb names its reason', () => {
  const REASON = 'No pull request is linked to this ticket yet.';
  const qaPart = (actions: PanelActionView[]): PanelPartView =>
    part({ key: 'qa', kind: 'qa', name: 'QA verification', stateText: 'not started', actions });

  it('disables the button and points it at the reason line under the part', () => {
    const node = build({
      parts: [
        qaPart([
          { command: 'cgremlin.verifyInQa', label: 'Verify in QA', placement: 'inline', enabled: false, reason: REASON },
        ]),
      ],
    });
    const qa = node.byClass('part').find((p) => p.dataset.key?.endsWith(':qa'))!;
    const button = qa.byClass('part-actions')[0].children[0];
    const reason = qa.byClass('action-reason')[0];
    expect(button.disabled).toBe(true);
    expect(reason.id).not.toBe('');
    expect(button.getAttribute('aria-describedby')).toBe(reason.id);
    expect(reason.textContent).toBe(`Verify in QA: ${REASON}`);
    // Never a tooltip, and never an emoji.
    expect(button.getAttribute('title')).toBeNull();
  });

  it('leaves an enabled verb undescribed, and draws no reason line at all', () => {
    const node = build({
      parts: [qaPart([{ command: 'cgremlin.verifyInQa', label: 'Verify in QA', placement: 'inline' }])],
    });
    const qa = node.byClass('part').find((p) => p.dataset.key?.endsWith(':qa'))!;
    const button = qa.byClass('part-actions')[0].children[0];
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-describedby')).toBeNull();
    expect(qa.byClass('action-reason').length).toBe(0);
  });

  it('mutates nothing on a re-render over the same data (P0-4)', () => {
    const row = rowView({
      parts: [
        qaPart([
          { command: 'cgremlin.verifyInQa', label: 'Verify in QA', placement: 'inline', enabled: false, reason: REASON },
          { command: 'cgremlin.discoverPrs', label: 'Find merged PRs', placement: 'inline' },
        ]),
      ],
    });
    const node = createExpanded() as unknown as FakeElement;
    patchExpanded(node as unknown as HTMLElement, row, null);
    doc.clearLog();
    patchExpanded(node as unknown as HTMLElement, row, null);
    expect(doc.log).toEqual([]);
  });
});
