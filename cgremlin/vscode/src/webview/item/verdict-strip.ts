/**
 * Phase 17 §3 — the verdict, above the fold.
 *
 * A review carries a verdict, a ticket answer and per-finding severities, and the tab rendered all
 * of it as undifferentiated markdown: the answer the user came for was somewhere in the scroll.
 * The strip is the first child of every pane that HAS a verdict.
 *
 * It says nothing where it read nothing. An absent strip means "unstructured"; a `0 findings`
 * would mean "clean", which is a different claim and one the parser never made (MG-17c).
 *
 * Runs in a browser context (R40).
 */
import { severityCountsOf, ticketAnswerOf, verdictOf } from '../../model/artifact-outline';
import { el, reconcile, setClass, setHidden, setText } from './dom';

interface Parts {
  line: HTMLElement;
  counts: HTMLElement;
}

const PARTS = new WeakMap<HTMLElement, Parts>();

export function createVerdictStrip(): HTMLElement {
  const strip = el('div', 'verdict-strip');
  // The pane's content changes under the same element, so the verdict is announced on a change.
  strip.setAttribute('role', 'status');
  const parts: Parts = { line: el('p', 'verdict-line'), counts: el('p', 'verdict-counts') };
  strip.appendChild(parts.line);
  strip.appendChild(parts.counts);
  PARTS.set(strip, parts);
  return strip;
}

/** `Request changes — the sentence`, or just the label where the artifact wrote no sentence. */
function lineOf(label: string, sentence: string): string {
  return sentence === '' ? label : `${label} — ${sentence}`;
}

export function patchVerdictStrip(strip: HTMLElement, text: string): void {
  const parts = PARTS.get(strip);
  if (parts === undefined) return;
  const verdict = verdictOf(text);
  setHidden(strip, verdict === null);
  setClass(strip, `verdict-strip tone-${verdict?.tone ?? 'neutral'}`);
  setText(parts.line, verdict === null ? '' : lineOf(verdict.label, verdict.sentence));

  const answer = ticketAnswerOf(text);
  const counts = verdict === null ? [] : severityCountsOf(text);
  const cells = [
    ...(answer === null ? [] : [{ key: 'ticket', label: `Ticket: ${answer}` }]),
    // §3: gap-separated, no separator glyph, and a severity with no findings is simply absent.
    ...counts.map((count) => ({
      key: count.word,
      label: `${count.count} ${count.word.toLowerCase()}`,
    })),
  ];
  reconcile(
    parts.counts,
    cells.map((cell) => ({ key: cell.key, data: cell })),
    (cell) => el('span', `verdict-count severity-${cell.key.toLowerCase().replace(/\W+/g, '-')}`),
    (node, cell) => setText(node, cell.label),
  );
}
