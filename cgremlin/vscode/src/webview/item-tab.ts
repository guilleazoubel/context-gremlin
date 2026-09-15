/**
 * The Item tab's webview entry (R19, R39, R40, R48).
 *
 * It owns no data: it posts `ready`, renders whatever `render` hands it, and patches one artifact
 * body on `patch`. Every non-markdown string goes through `escapeHtml` or `textContent`; the only
 * `innerHTML` assignment is the markdown-it output, tagged SAFE_HTML so MG-B7's grep can see the
 * difference.
 *
 * esbuild bundles this file (with `markdown-it`) into `media/item-tab.js`; the host inlines that
 * text under the CSP of R38. It runs in a browser context, so it never imports the editor module.
 */
import { escapeHtml, escapeAttribute, safeHref } from '../model/escape-html';
import type {
  HostToWebview,
  ItemTabState,
  TabAgent,
  TabArtifact,
  TabPr,
} from '../model/item-tab-protocol';
import { renderArtifact } from './markdown';
import { BRIEF_ONLY_NOTICE, artifactLabel, briefOnly, orderArtifacts } from '../model/artifact-labels';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const api = acquireVsCodeApi();
let state: ItemTabState | null = null;

function post(message: unknown): void {
  api.postMessage(message);
}

function el(tag: string, className?: string, textContent?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (textContent !== undefined) node.textContent = textContent;
  return node;
}

function root(): HTMLElement {
  let node = document.getElementById('cgremlin-item');
  if (node === null) {
    node = el('div');
    node.id = 'cgremlin-item';
    document.body.appendChild(node);
  }
  return node;
}

function header(current: ItemTabState): HTMLElement {
  const box = el('header', 'item-header');
  const title = el('h1', 'item-title', current.title);
  if (current.needsYou) title.appendChild(el('span', 'badge needs-you', '❗'));
  box.appendChild(title);
  const chips = el('div', 'chips');
  for (const chip of current.chips) {
    const href = safeHref(chip.url);
    if (href === null) {
      chips.appendChild(el('span', 'chip', chip.label));
      continue;
    }
    const link = document.createElement('a');
    link.className = 'chip';
    link.href = '#';
    link.textContent = chip.label;
    // §3: the chip already names the PR, so the URL behind it was a tooltip saying nothing new.
    // What a screen reader lacked was where the link GOES, and that is said as a name, not a hover.
    link.setAttribute('aria-label', `Open ${chip.label} on GitHub`);
    link.addEventListener('click', (event) => {
      event.preventDefault();
      post({ type: 'openLink', url: href });
    });
    chips.appendChild(link);
  }
  box.appendChild(chips);
  return box;
}

/**
 * The buttons, and — under them — why any of them is disabled.
 *
 * §3: the reason used to be the disabled button's `title`, which is the one tooltip a browser
 * will not even show on a disabled control in every engine. A disabled button with no readable
 * reason is the worst of both, so the reasons are a line of text beneath the group.
 */
function buttons(current: ItemTabState): HTMLElement {
  const box = el('div', 'button-group');
  const row = el('div', 'buttons');
  for (const button of current.buttons) {
    const node = document.createElement('button');
    node.textContent = button.label;
    node.disabled = !button.enabled;
    node.addEventListener('click', () =>
      post({ type: 'command', command: button.id, arg: current.itemId }),
    );
    row.appendChild(node);
  }
  box.appendChild(row);
  for (const button of current.buttons) {
    if (button.enabled || button.reason === undefined) continue;
    box.appendChild(el('p', 'button-reason', `${button.label}: ${button.reason}`));
  }
  return box;
}

function agentTabs(current: ItemTabState): HTMLElement {
  const tabs = el('div', 'agent-tabs');
  for (const agent of current.agents) {
    const tab = document.createElement('button');
    tab.className = agent.sessionId === current.selectedSessionId ? 'agent-tab selected' : 'agent-tab';
    tab.textContent = `${agent.glyph} ${agent.mode} · ${agent.phase}`;
    tab.addEventListener('click', () => post({ type: 'selectAgent', sessionId: agent.sessionId }));
    tabs.appendChild(tab);
  }
  return tabs;
}

/**
 * §14: the block says WHAT this artifact is before it says what it is called.
 *
 * A brief's own first line is `# REVIEW — PR #2061`, because it is the brief FOR a review — so a
 * block headed `BRIEF.md · <iso>` and filled with rendered instructions reads as the verdict. The
 * role label is the heading; the filename and the mtime stay, underneath, as provenance.
 * `model/artifact-labels` is the ONE place that decides a role (no second naming rule here).
 */
function artifactBlock(artifact: TabArtifact): HTMLElement {
  const box = el('details', 'artifact');
  box.setAttribute('open', '');
  box.id = `artifact-${artifact.sessionId}-${artifact.name}`;
  const summary = el('summary');
  summary.appendChild(el('span', 'artifact-label', artifactLabel(artifact.name)));
  summary.appendChild(el('span', 'artifact-file', `${artifact.name} · ${artifact.mtime}`));
  box.appendChild(summary);
  const body = el('div', 'artifact-body');
  if (artifact.text === null) body.textContent = 'Loading…';
  else body.innerHTML = renderArtifact(artifact.text); // SAFE_HTML: markdown-it, html:false (R40)
  box.appendChild(body);
  return box;
}

function agentFocus(agent: TabAgent): HTMLElement {
  const box = el('section', 'focus agent-focus');
  // §3: the session id was the tab's tooltip. It is the one string a user needs when talking to
  // the engine about a run, so it is written down — once, on the pane it identifies.
  box.appendChild(el('p', 'agent-session', `${agent.mode} · ${agent.phase} · ${agent.sessionId}`));
  if (agent.artifacts.length === 0) {
    box.appendChild(el('p', 'empty', 'This agent has written no artifact yet.'));
    return box;
  }
  const names = agent.artifacts.map((a) => a.name);
  // The brief is context, never the answer: the real output leads, the brief comes last, and when
  // the brief is ALL there is the pane says so BEFORE the user starts reading it as a review.
  if (briefOnly(names)) box.appendChild(el('p', 'artifact-notice', BRIEF_ONLY_NOTICE));
  const order = orderArtifacts(names);
  const sorted = [...agent.artifacts].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  for (const artifact of sorted) box.appendChild(artifactBlock(artifact));
  return box;
}

function prFocus(pr: TabPr): HTMLElement {
  const box = el('section', 'focus pr-focus');
  box.appendChild(el('h2', undefined, `${pr.repo}#${pr.number} — ${pr.title ?? ''}`.trim()));
  const facts = el('ul', 'pr-facts');
  const add = (label: string, value: string): void => {
    if (value === '') return;
    facts.appendChild(el('li', undefined, `${label}: ${value}`));
  };
  add('State', pr.state);
  add('Review decision', pr.reviewDecision ?? '');
  add('CI', pr.ci);
  add(
    'Diff',
    pr.changedFiles === null
      ? ''
      : `${pr.changedFiles} files +${pr.additions ?? 0}/−${pr.deletions ?? 0}`,
  );
  add('Open threads', pr.openThreads === null ? '' : String(pr.openThreads));
  box.appendChild(facts);
  if (pr.reviewers.length > 0) {
    box.appendChild(el('h3', undefined, 'Reviews'));
    const list = el('ul', 'reviewers');
    for (const reviewer of pr.reviewers) {
      list.appendChild(
        el('li', undefined, `@${reviewer.login} — ${reviewer.state}${reviewer.body === null ? '' : `: ${reviewer.body}`}`),
      );
    }
    box.appendChild(list);
  }
  if (pr.checks.length > 0) {
    box.appendChild(el('h3', undefined, 'Checks'));
    const list = el('ul', 'checks');
    for (const check of pr.checks) list.appendChild(el('li', undefined, `${check.name} — ${check.state}`));
    box.appendChild(list);
  }
  const href = safeHref(pr.url);
  if (href !== null) {
    const link = document.createElement('a');
    link.href = '#';
    link.textContent = 'Open on GitHub';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      post({ type: 'openLink', url: href });
    });
    box.appendChild(link);
  }
  return box;
}

function ticketSection(current: ItemTabState): HTMLElement | null {
  if (current.ticket === null) {
    if (current.ticketError === null) return null;
    const box = el('section', 'focus ticket-focus');
    box.appendChild(el('p', 'error', current.ticketError));
    return box;
  }
  const ticket = current.ticket;
  const box = el('section', 'focus ticket-focus');
  box.id = 'ticket-section';
  box.appendChild(el('h2', undefined, `${ticket.key} — ${ticket.summary}`));
  box.appendChild(
    el('p', 'ticket-meta', `${ticket.status}${ticket.assignee === null ? '' : ` · ${ticket.assignee}`}`),
  );
  // R33: the description is TEXT by the time it gets here, and it is shown as text.
  box.appendChild(el('pre', 'ticket-description', ticket.descriptionText ?? ''));
  for (const comment of ticket.comments) {
    const entry = el('div', 'ticket-comment');
    entry.appendChild(el('div', 'ticket-comment-author', `${comment.author} · ${comment.at}`));
    entry.appendChild(el('pre', undefined, comment.bodyText ?? ''));
    box.appendChild(entry);
  }
  return box;
}

export function render(current: ItemTabState): void {
  state = current;
  const container = root();
  container.textContent = '';
  container.appendChild(header(current));
  container.appendChild(buttons(current));
  container.appendChild(agentTabs(current));

  const focus = current.focus;
  if (focus.kind === 'pr') {
    const pr = current.prs.find(
      (candidate) => candidate.repo === focus.repo && candidate.number === focus.number,
    );
    // An unknown focus falls back to the primary agent rather than rendering blank (R48).
    if (pr !== undefined) container.appendChild(prFocus(pr));
    else if (current.agents[0] !== undefined) container.appendChild(agentFocus(current.agents[0]));
  } else {
    const agent =
      current.agents.find((a) => a.sessionId === current.selectedSessionId) ?? current.agents[0];
    if (agent !== undefined) container.appendChild(agentFocus(agent));
  }
  const ticket = ticketSection(current);
  if (ticket !== null) {
    container.appendChild(ticket);
    if (focus.kind === 'ticket') ticket.scrollIntoView();
  }
  // A title carrying markup must be inert in the document, not merely escaped in a string.
  document.title = escapeHtml(current.title).length === 0 ? 'cgremlin' : current.title;
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
