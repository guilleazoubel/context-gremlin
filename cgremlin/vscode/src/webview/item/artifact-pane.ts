/**
 * Phase 17 §1 — ONE artifact, as its own pane.
 *
 * What it replaces: a `<details>` accordion holding every artifact the agent wrote, stacked into
 * one scroll. An artifact is a pane now, so the accordion is gone and the pane is named by its
 * tab rather than by a summary row.
 *
 * Runs in a browser context (R40).
 */
import { BRIEF_ONLY_NOTICE, briefOnly } from '../../model/artifact-labels';
import type { TabAgent, TabArtifact } from '../../model/item-tab-protocol';
import { renderArtifact } from '../markdown';
import { el, setHidden, setHtml, setText } from './dom';

export interface ArtifactPaneData {
  agent: TabAgent;
  artifact: TabArtifact;
}

interface Parts {
  notice: HTMLElement;
  body: HTMLElement;
}

const PARTS = new WeakMap<HTMLElement, Parts>();

export function createArtifactPane(): HTMLElement {
  const pane = el('section', 'pane artifact-pane');
  const notice = el('p', 'artifact-notice', BRIEF_ONLY_NOTICE);
  const body = el('div', 'artifact-body');
  pane.appendChild(notice);
  pane.appendChild(body);
  PARTS.set(pane, { notice, body });
  return pane;
}

export function patchArtifactPane(pane: HTMLElement, data: ArtifactPaneData): void {
  const parts = PARTS.get(pane);
  if (parts === undefined) return;
  // The brief is context, never the answer: when it is ALL there is, the pane says so BEFORE the
  // user starts reading an agent's ORDERS as its verdict.
  const names = data.agent.artifacts.map((artifact) => artifact.name);
  setHidden(parts.notice, !briefOnly(names));
  if (data.artifact.text === null) setText(parts.body, 'Loading…');
  else setHtml(parts.body, renderArtifact(data.artifact.text));
}
