/**
 * Phase 17 §1 — the item's parts, in one fixed order, as the list the tablist draws.
 *
 * The defect this exists for is "one unbroken scroll": the tab appended the agent's artifacts AND
 * the ticket into a single document, and the focus union could not address one of them. So the
 * parts are named here — the selected agent's artifacts in the fixed role order the rule
 * `artifact-labels` owns, then the ticket, then one per PR — and each carries the focus that puts
 * it on screen. WHICH of them opens is a separate question, answered host-side by `resolveFocus`.
 *
 * No verb, no DOM, no editor API (MG-B1). The switcher reads this list and nothing else.
 */
import { artifactTabLabel, orderArtifactTabs } from './artifact-labels';
import { prRefOf } from './row-composition';
import type { ItemFocusMessage, ItemTabState } from './item-tab-protocol';

/**
 * One word, and the same word whether the run is live or over (§1's fixed order applies to the
 * LABEL as well as the position). Which of those it is, the pane itself says.
 */
export const RUN_OUTPUT_LABEL = 'Output';

export interface TabPart {
  /** Stable across renders, so the tablist reconciles by identity rather than by position. */
  key: string;
  /** One word for an artifact, `Ticket`, or `#<number>` for a PR (the chip says the repo). */
  label: string;
  focus: ItemFocusMessage;
}

export function partOfFocus(parts: readonly TabPart[], focus: ItemFocusMessage): TabPart | null {
  return parts.find((part) => sameFocus(part.focus, focus)) ?? null;
}

/** Structural equality over the union — the tab compares focuses in exactly one place. */
export function sameFocus(a: ItemFocusMessage, b: ItemFocusMessage): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'agent' && b.kind === 'agent') return a.sessionId === b.sessionId;
  if (a.kind === 'artifact' && b.kind === 'artifact') {
    return a.sessionId === b.sessionId && a.name === b.name;
  }
  if (a.kind === 'pr' && b.kind === 'pr') return a.repo === b.repo && a.number === b.number;
  return a.kind === 'ticket';
}

export function partsOf(state: ItemTabState): TabPart[] {
  const parts: TabPart[] = [];
  const agent =
    state.agents.find((candidate) => candidate.sessionId === state.selectedSessionId) ??
    state.agents[0];
  if (agent !== undefined) {
    const names = agent.artifacts.map((artifact) => artifact.name);
    for (const name of orderArtifactTabs(names)) {
      parts.push({
        key: `artifact:${agent.sessionId}/${name}`,
        label: artifactTabLabel(name),
        focus: { kind: 'artifact', sessionId: agent.sessionId, name },
      });
    }
    // Defect 4 — after the documents and before the ticket, in a FIXED position like every other
    // part (§1): a tab that moves as a run starts and stops is unlearnable. It exists only where
    // a buffer does, which is only where somebody asked to watch.
    if (agent.runOutput != null) {
      parts.push({
        key: `runOutput:${agent.sessionId}`,
        label: RUN_OUTPUT_LABEL,
        focus: { kind: 'runOutput', sessionId: agent.sessionId },
      });
    }
  }
  // A ticket the host could not READ is still a part of the item: the pane carries the reason,
  // because a tab that silently disappears reads as "there is no ticket".
  if (state.ticket !== null || state.ticketError !== null) {
    parts.push({ key: 'ticket', label: 'Ticket', focus: { kind: 'ticket' } });
  }
  for (const pr of state.prs) {
    parts.push({
      key: prRefOf(pr),
      label: `#${pr.number}`,
      focus: { kind: 'pr', repo: pr.repo, number: pr.number },
    });
  }
  return parts;
}
