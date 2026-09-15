/**
 * The Item tab's webview entry (R19, R39, R40, R48; Phase 17 §1-§2).
 *
 * It owns no data: it posts `ready`, renders whatever `render` hands it, and patches one artifact
 * body on `patch`. Phase 17 changed HOW it renders: the document used to be torn down and rebuilt
 * on every message (`container.textContent = ''`), which is why a background refresh moved the
 * scroll and dropped the caret. The frame is built once and reconciled by key after that, so a
 * render over identical data performs no write at all.
 *
 * One part is on screen at a time — the tablist of `item/tablist` chooses it. Every non-markdown
 * string reaches the DOM through `textContent`; the only `innerHTML` assignment is `dom.setHtml`,
 * which is only ever handed markdown-it's output (MG-B7).
 *
 * esbuild bundles this file (with `markdown-it`) into `media/item-tab.js`; the host inlines that
 * text under the CSP of R38. It runs in a browser context, so it never imports the editor module.
 */
import { escapeHtml, escapeAttribute, safeHref } from '../model/escape-html';
import type { HostToWebview, ItemTabState, TabArtifact } from '../model/item-tab-protocol';
import { partOfFocus, type TabPart } from '../model/item-tab-parts';
import { post } from './item/channel';
import { el, reconcile, setAttr, setClass, setDisabled, setHidden, setText } from './item/dom';
import { createSwitcher, tabIdOf, type Switcher } from './item/tablist';
import { createArtifactPane, patchArtifactPane } from './item/artifact-pane';
import { createTicketPane, patchTicketPane } from './item/ticket-pane';
import { createPrPane, patchPrPane } from './item/pr-pane';

let state: ItemTabState | null = null;
/** The part the pane is currently showing, so the caret moves only when it actually changes. */
let showing: string | null = null;

interface Frame {
  titleText: HTMLElement;
  needsYou: HTMLElement;
  chips: HTMLElement;
  buttons: HTMLElement;
  reasons: HTMLElement;
  switcher: Switcher;
  agentTabs: HTMLElement;
  paneHost: HTMLElement;
}

let frame: Frame | null = null;

function root(): HTMLElement {
  let node = document.getElementById('cgremlin-item');
  if (node === null) {
    node = el('div');
    node.id = 'cgremlin-item';
    document.body.appendChild(node);
  }
  return node;
}

/** Built exactly once. Everything after this is a patch, which is the whole of MG-17e. */
function frameOf(): Frame {
  if (frame !== null) return frame;
  const container = root();
  const header = el('header', 'item-header');
  const title = el('h1', 'item-title');
  const titleText = el('span', 'item-title-text');
  const needsYou = el('span', 'badge needs-you', '❗');
  const chips = el('div', 'chips');
  title.appendChild(titleText);
  title.appendChild(needsYou);
  header.appendChild(title);
  header.appendChild(chips);
  const group = el('div', 'button-group');
  const buttons = el('div', 'buttons');
  const reasons = el('div', 'button-reasons');
  group.appendChild(buttons);
  group.appendChild(reasons);
  const switcher = createSwitcher();
  const agentTabs = el('div', 'agent-tabs');
  const paneHost = el('div', 'pane-host');
  for (const node of [header, group, switcher.node, agentTabs, paneHost]) {
    container.appendChild(node);
  }
  frame = { titleText, needsYou, chips, buttons, reasons, switcher, agentTabs, paneHost };
  return frame;
}

function patchHeader(current: ItemTabState, f: Frame): void {
  // MG-17a: this is the ONE title in the document. The ticket pane prints no second one, and
  // every artifact body has its own `# ` line stripped before it is rendered.
  setText(f.titleText, current.title);
  setHidden(f.needsYou, !current.needsYou);
  reconcile(
    f.chips,
    current.chips.map((chip) => ({ key: chip.label, data: chip })),
    (chip) => {
      const node = document.createElement('a');
      node.className = 'chip';
      node.href = '#';
      node.addEventListener('click', (event: Event) => {
        event.preventDefault();
        const href = safeHref(chip.url);
        if (href !== null) post({ type: 'openLink', url: href });
      });
      return node;
    },
    (node, chip) => {
      setText(node, chip.label);
      // §3: the chip already names the PR, so the URL behind it was a tooltip saying nothing new.
      // What a screen reader lacked was where the link GOES, said as a name and not as a hover.
      setAttr(node, 'aria-label', `Open ${chip.label} on GitHub`);
    },
  );
}

/**
 * The buttons, and — under them — why any of them is disabled.
 *
 * §3: the reason used to be the disabled button's `title`, which is the one tooltip a browser
 * will not even show on a disabled control in every engine.
 */
function patchButtons(current: ItemTabState, f: Frame): void {
  reconcile(
    f.buttons,
    current.buttons.map((button) => ({ key: button.id, data: button })),
    (button) => {
      const node = document.createElement('button');
      node.type = 'button';
      node.addEventListener('click', () =>
        post({ type: 'command', command: button.id, arg: state?.itemId }),
      );
      return node;
    },
    (node, button) => {
      setText(node, button.label);
      // §6: exactly one filled button. The rule decided the placement; the tab only draws it.
      setClass(node, `action ${button.placement}`);
      setDisabled(node as HTMLButtonElement, !button.enabled);
    },
  );
  const reasons = current.buttons.filter((b) => !b.enabled && b.reason !== undefined);
  reconcile(
    f.reasons,
    reasons.map((button) => ({ key: button.id, data: button })),
    () => el('p', 'button-reason'),
    (node, button) => setText(node, `${button.label}: ${button.reason ?? ''}`),
  );
}

/** §1: the agent switcher is drawn only where there is more than one agent to switch between. */
function patchAgentTabs(current: ItemTabState, f: Frame): void {
  const agents = current.agents.length > 1 ? current.agents : [];
  setHidden(f.agentTabs, agents.length === 0);
  reconcile(
    f.agentTabs,
    agents.map((agent) => ({ key: agent.sessionId, data: agent })),
    (agent) => {
      const node = document.createElement('button');
      node.type = 'button';
      node.addEventListener('click', () =>
        post({ type: 'selectAgent', sessionId: agent.sessionId }),
      );
      return node;
    },
    (node, agent) => {
      setText(node, `${agent.glyph} ${agent.mode} · ${agent.phase}`);
      setClass(
        node,
        agent.sessionId === current.selectedSessionId ? 'agent-tab selected' : 'agent-tab',
      );
    },
  );
}

/**
 * §1/§2 — ONE pane, chosen by the tablist.
 *
 * Keyed on the part, so switching parts replaces the pane wholesale and staying on one part
 * patches it in place. A previous pane's scroll offset is not restored: a different document is a
 * different place.
 */
function patchPane(current: ItemTabState, f: Frame): void {
  const part = partOfFocus(current.parts, current.focus) ?? current.parts[0] ?? null;
  f.switcher.render(current.parts, part?.key ?? null);
  const items = part === null ? [] : [{ key: part.key, data: part }];
  const [pane] = reconcile(f.paneHost, items, createPane, (node, data) =>
    patchPaneOf(node, data, current),
  );
  if (pane === undefined) {
    showing = null;
    return;
  }
  setAttr(pane, 'role', 'tabpanel');
  setAttr(pane, 'aria-labelledby', tabIdOf(part?.key ?? ''));
  if (pane.tabIndex !== -1) pane.tabIndex = -1;
  if (showing === part?.key) return;
  showing = part?.key ?? null;
  // A screen reader must land on the new content, and a new document starts at its top.
  pane.scrollTop = 0;
  pane.focus();
}

function createPane(part: TabPart): HTMLElement {
  if (part.focus.kind === 'ticket') return createTicketPane();
  if (part.focus.kind === 'pr') return createPrPane();
  return createArtifactPane();
}

function patchPaneOf(pane: HTMLElement, part: TabPart, current: ItemTabState): void {
  const focus = part.focus;
  if (focus.kind === 'ticket') {
    patchTicketPane(pane, current.ticket, current.ticketError);
    return;
  }
  if (focus.kind === 'pr') {
    const pr = current.prs.find((one) => one.repo === focus.repo && one.number === focus.number);
    if (pr !== undefined) patchPrPane(pane, pr);
    return;
  }
  if (focus.kind !== 'artifact') return;
  const agent = current.agents.find((one) => one.sessionId === focus.sessionId);
  const artifact = agent?.artifacts.find((one) => one.name === focus.name);
  if (agent === undefined || artifact === undefined) return;
  patchArtifactPane(pane, { agent, artifact });
}

export function render(current: ItemTabState): void {
  state = current;
  const f = frameOf();
  patchHeader(current, f);
  patchButtons(current, f);
  patchAgentTabs(current, f);
  patchPane(current, f);
  // A title carrying markup must be inert in the document, not merely escaped in a string.
  const title = escapeHtml(current.title).length === 0 ? 'cgremlin' : current.title;
  if (document.title !== title) document.title = title;
}

function patch(artifact: TabArtifact): void {
  if (state === null) return;
  for (const agent of state.agents) {
    if (agent.sessionId !== artifact.sessionId) continue;
    const at = agent.artifacts.findIndex((a) => a.name === artifact.name);
    if (at >= 0) agent.artifacts[at] = artifact;
    else agent.artifacts.unshift(artifact);
  }
  render(state);
}

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as HostToWebview;
  if (message === null || typeof message !== 'object') return;
  if (message.type === 'render') render(message.state);
  else if (message.type === 'patch') patch(message.artifact);
});

// R39: the host renders only in reply to this, so a first open can never be blank.
post({ type: 'ready' });

// Referenced so the bundler keeps it and so a future attribute interpolation has one helper.
export const escapeForAttribute = escapeAttribute;
