/**
 * Phase 17 §1/§3/§5a — ONE artifact, as its own pane.
 *
 * What it replaces: a `<details>` accordion holding every artifact the agent wrote, stacked into
 * one scroll. An artifact is a pane now, so the accordion is gone and the pane is named by its
 * tab rather than by a summary row.
 *
 * Three things happen to the text before it is drawn: its own `# ` first line is stripped (it was
 * the THIRD copy of the item's title, MG-17a), its verdict is lifted into a strip above the fold,
 * and the intra-report `[N](#fN)` links are kept inside the pane.
 *
 * Runs in a browser context (R40).
 */
import { artifactLabel, BRIEF_ONLY_NOTICE, briefOnly } from '../../model/artifact-labels';
import { compactAge } from '../../model/row-composition';
import { stripLeadingH1 } from '../../model/artifact-outline';
import type { TabAgent, TabArtifact } from '../../model/item-tab-protocol';
import { renderArtifact } from '../markdown';
import { el, setHidden, setHtml, setText, walk } from './dom';
import { linkFileRefs } from './file-refs';
import { createVerdictStrip, patchVerdictStrip } from './verdict-strip';

export interface ArtifactPaneData {
  agent: TabAgent;
  artifact: TabArtifact;
}

interface Parts {
  meta: HTMLElement;
  strip: HTMLElement;
  notice: HTMLElement;
  body: HTMLElement;
  /** The text last rendered into `body`, so an unchanged patch rewires nothing. */
  rendered: string | null;
}

const PARTS = new WeakMap<HTMLElement, Parts>();

/**
 * §2: navigation inside a long review is the document's own contents.
 *
 * `markdown.ts` synthesises the `<span id="fN">` targets the `[N](#fN)` links point at, so the
 * jump is a scroll and nothing else — no navigation out of the webview, and no history entry.
 */
function wireAnchors(body: HTMLElement): void {
  walk(body, (node) => {
    if (node.tagName !== 'A') return;
    const href = node.getAttribute('href');
    if (href === null || !href.startsWith('#')) return;
    node.addEventListener('click', (event: Event) => {
      event.preventDefault();
      const target = document.getElementById(href.slice(1));
      target?.scrollIntoView({ block: 'start' });
    });
  });
}

/**
 * §7 — every table in its own scrolling block.
 *
 * `overflow-x: auto` on a `display: table` element establishes no scroll container, so a five
 * column findings table simply overflowed and took the whole document sideways with it at 400px.
 */
function wrapTables(body: HTMLElement): void {
  walk(body, (node) => {
    if (node.tagName !== 'TABLE') return;
    const parent = node.parentElement;
    if (parent === null || parent.className === 'table-scroll') return;
    const box = el('div', 'table-scroll');
    parent.insertBefore(box, node);
    box.appendChild(node);
  });
}

export function createArtifactPane(): HTMLElement {
  const pane = el('section', 'pane artifact-pane');
  const parts: Parts = {
    // §7 budgets one 11px line for this. Without it nothing on screen said whether the review was
    // written five minutes ago or last month, which is the first thing a reader needs to know.
    meta: el('p', 'artifact-meta'),
    strip: createVerdictStrip(),
    notice: el('p', 'artifact-notice', BRIEF_ONLY_NOTICE),
    body: el('div', 'artifact-body'),
    rendered: null,
  };
  pane.appendChild(parts.meta);
  pane.appendChild(parts.strip);
  pane.appendChild(parts.notice);
  pane.appendChild(parts.body);
  PARTS.set(pane, parts);
  return pane;
}

/** `Review · 3h ago` — the role this document plays, and its age in the row's own wording. */
function metaOf(artifact: TabArtifact): string {
  const label = artifactLabel(artifact.name);
  const age = compactAge(artifact.mtime === '' ? null : artifact.mtime, Date.now());
  return age === '—' ? label : `${label} · ${age} ago`;
}

export function patchArtifactPane(pane: HTMLElement, data: ArtifactPaneData): void {
  const parts = PARTS.get(pane);
  if (parts === undefined) return;
  // The brief is context, never the answer: when it is ALL there is, the pane says so BEFORE the
  // user starts reading an agent's ORDERS as its verdict.
  const names = data.agent.artifacts.map((artifact) => artifact.name);
  setText(parts.meta, metaOf(data.artifact));
  setHidden(parts.notice, !briefOnly(names));
  const text = data.artifact.text;
  if (text === null) {
    setHidden(parts.strip, true);
    setText(parts.body, 'Loading…');
    parts.rendered = null;
    return;
  }
  patchVerdictStrip(parts.strip, text);
  // MG-17a: the stripped title is DISCARDED, never re-printed — the header already said it.
  const body = stripLeadingH1(text).body;
  if (parts.rendered === body) return;
  parts.rendered = body;
  setHtml(parts.body, renderArtifact(body));
  linkFileRefs(parts.body);
  wireAnchors(parts.body);
  wrapTables(parts.body);
}
