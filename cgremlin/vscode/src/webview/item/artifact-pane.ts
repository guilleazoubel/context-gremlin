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
import { BRIEF_ONLY_NOTICE, briefOnly } from '../../model/artifact-labels';
import { stripLeadingH1 } from '../../model/artifact-outline';
import type { TabAgent, TabArtifact } from '../../model/item-tab-protocol';
import { renderArtifact } from '../markdown';
import { el, setHidden, setHtml, setText, walk } from './dom';
import { createVerdictStrip, patchVerdictStrip } from './verdict-strip';

export interface ArtifactPaneData {
  agent: TabAgent;
  artifact: TabArtifact;
}

interface Parts {
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

export function createArtifactPane(): HTMLElement {
  const pane = el('section', 'pane artifact-pane');
  const parts: Parts = {
    strip: createVerdictStrip(),
    notice: el('p', 'artifact-notice', BRIEF_ONLY_NOTICE),
    body: el('div', 'artifact-body'),
    rendered: null,
  };
  pane.appendChild(parts.strip);
  pane.appendChild(parts.notice);
  pane.appendChild(parts.body);
  PARTS.set(pane, parts);
  return pane;
}

export function patchArtifactPane(pane: HTMLElement, data: ArtifactPaneData): void {
  const parts = PARTS.get(pane);
  if (parts === undefined) return;
  // The brief is context, never the answer: when it is ALL there is, the pane says so BEFORE the
  // user starts reading an agent's ORDERS as its verdict.
  const names = data.agent.artifacts.map((artifact) => artifact.name);
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
  wireAnchors(parts.body);
}
