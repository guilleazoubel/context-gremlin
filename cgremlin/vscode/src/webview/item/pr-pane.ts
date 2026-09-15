/**
 * Phase 17 §1 — one pull request, as its own pane.
 *
 * Runs in a browser context (R40).
 */
import { safeHref } from '../../model/escape-html';
import type { TabPr } from '../../model/item-tab-protocol';
import { post } from './channel';
import { el, reconcile, setHidden, setText } from './dom';

interface Parts {
  facts: HTMLElement;
  reviewersHeading: HTMLElement;
  reviewers: HTMLElement;
  checksHeading: HTMLElement;
  checks: HTMLElement;
  link: HTMLElement;
}

const PARTS = new WeakMap<HTMLElement, Parts>();
/** The PR the pane is currently showing — read by the click handler, which is attached once. */
const SHOWING = new WeakMap<HTMLElement, TabPr>();

function list(className: string): HTMLElement {
  return el('ul', className);
}

function line(): HTMLElement {
  return el('li');
}

export function createPrPane(): HTMLElement {
  const pane = el('section', 'pane pr-pane');
  const parts: Parts = {
    facts: list('pr-facts'),
    reviewersHeading: el('h2', 'pane-heading', 'Reviews'),
    reviewers: list('reviewers'),
    checksHeading: el('h2', 'pane-heading', 'Checks'),
    checks: list('checks'),
    link: el('button', 'pr-link', 'Open on GitHub'),
  };
  for (const node of Object.values(parts)) pane.appendChild(node);
  PARTS.set(pane, parts);
  parts.link.addEventListener('click', () => {
    const href = safeHref(SHOWING.get(pane)?.url ?? '');
    if (href !== null) post({ type: 'openLink', url: href });
  });
  return pane;
}

function factsOf(pr: TabPr): string[] {
  const out = [`State: ${pr.state}`];
  if (pr.reviewDecision !== null) out.push(`Review decision: ${pr.reviewDecision}`);
  if (pr.ci !== '') out.push(`CI: ${pr.ci}`);
  if (pr.changedFiles !== null) {
    out.push(`Diff: ${pr.changedFiles} files +${pr.additions ?? 0}/−${pr.deletions ?? 0}`);
  }
  if (pr.openThreads !== null) out.push(`Open threads: ${pr.openThreads}`);
  return out;
}

function fill(parent: HTMLElement, texts: readonly string[]): void {
  reconcile(
    parent,
    texts.map((text, at) => ({ key: `${at}`, data: text })),
    line,
    (node, text) => setText(node, text),
  );
}

export function patchPrPane(pane: HTMLElement, pr: TabPr): void {
  const parts = PARTS.get(pane);
  if (parts === undefined) return;
  fill(parts.facts, factsOf(pr));
  setHidden(parts.reviewersHeading, pr.reviewers.length === 0);
  fill(
    parts.reviewers,
    pr.reviewers.map(
      (one) => `@${one.login} — ${one.state}${one.body === null ? '' : `: ${one.body}`}`,
    ),
  );
  setHidden(parts.checksHeading, pr.checks.length === 0);
  fill(parts.checks, pr.checks.map((check) => `${check.name} — ${check.state}`));
  SHOWING.set(pane, pr);
  setHidden(parts.link, safeHref(pr.url) === null);
}
