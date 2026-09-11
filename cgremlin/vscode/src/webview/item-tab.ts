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
    link.title = chip.url;
    link.addEventListener('click', (event) => {
      event.preventDefault();
      post({ type: 'openLink', url: href });
    });
    chips.appendChild(link);
  }
  box.appendChild(chips);
  return box;
}

function buttons(current: ItemTabState): HTMLElement {
  const row = el('div', 'buttons');
  for (const button of current.buttons) {
    const node = document.createElement('button');
    node.textContent = button.label;
    node.disabled = !button.enabled;
    if (button.reason !== undefined) node.title = button.reason;
    node.addEventListener('click', () =>
      post({ type: 'command', command: button.id, arg: current.itemId }),
    );
    row.appendChild(node);
  }
  return row;
}

function agentTabs(current: ItemTabState): HTMLElement {
  const tabs = el('div', 'agent-tabs');
  for (const agent of current.agents) {
    const tab = document.createElement('button');
    tab.className = agent.sessionId === current.selectedSessionId ? 'agent-tab selected' : 'agent-tab';
    tab.textContent = `${agent.glyph} ${agent.mode} · ${agent.phase}`;
    tab.title = agent.sessionId;
    tab.addEventListener('click', () => post({ type: 'selectAgent', sessionId: agent.sessionId }));
    tabs.appendChild(tab);
  }
  return tabs;
}

function artifactBlock(artifact: TabArtifact): HTMLElement {
  const box = el('details', 'artifact');
  box.setAttribute('open', '');
  box.id = `artifact-${artifact.sessionId}-${artifact.name}`;
  const summary = el('summary', undefined, `${artifact.name} · ${artifact.mtime}`);
  box.appendChild(summary);
  const body = el('div', 'artifact-body');
  if (artifact.text === null) body.textContent = 'Loading…';
  else body.innerHTML = renderArtifact(artifact.text); // SAFE_HTML: markdown-it, html:false (R40)
  box.appendChild(body);
  return box;
}

function agentFocus(agent: TabAgent): HTMLElement {
  const box = el('section', 'focus agent-focus');
  if (agent.artifacts.length === 0) {
    box.appendChild(el('p', 'empty', 'This agent has written no artifact yet.'));
    return box;
  }
  for (const artifact of agent.artifacts) box.appendChild(artifactBlock(artifact));
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
