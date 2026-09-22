/**
 * Defect 4 — ONE live run's output, as its own pane.
 *
 * The rule the whole pane is built on: it shows what it SAW and says what it did not. It is not
 * the record of the run and must never read as one — the artifact the run wrote is the record,
 * and `run-output.ts` explains why nothing else is possible. So the sentences above and below the
 * lines are as load-bearing as the lines themselves, and the empty case is the most important of
 * them: a live run with nothing printed yet SAYS so, because an empty box and a wedged agent look
 * identical and the user spent an afternoon unable to tell them apart.
 *
 * Lines are keyed by their ABSOLUTE line number (`dropped + index`), so appending writes only the
 * new nodes and the cap scrolling the front off writes none of the survivors.
 *
 * Runs in a browser context (R40). `textContent` only — agent output is not markdown and is never
 * treated as any kind of markup.
 */
import type { RunOutputView } from '../../model/run-output';
import { el, reconcile, setHidden, setText } from './dom';

interface Parts {
  meta: HTMLElement;
  notice: HTMLElement;
  lines: HTMLElement;
  ending: HTMLElement;
}

const PARTS = new WeakMap<HTMLElement, Parts>();

/** `plan · live` / `plan · ended` — the one line that says WHICH run this is and whether it is on. */
function metaOf(view: RunOutputView): string {
  const state = view.state === 'ended' ? 'ended' : view.state === 'notStarted' ? 'idle' : 'live';
  return view.stage === null || view.stage === '' ? state : `${view.stage} · ${state}`;
}

export function createRunOutputPane(): HTMLElement {
  const pane = el('section', 'pane run-output-pane');
  const parts: Parts = {
    meta: el('p', 'run-output-meta'),
    notice: el('p', 'run-output-notice'),
    // `log` rather than `list`: this is append-only output, and a screen reader should announce
    // new lines rather than re-read the whole thing. `polite` — it must never interrupt.
    lines: el('div', 'run-output-lines'),
    ending: el('p', 'run-output-ending'),
  };
  parts.lines.setAttribute('role', 'log');
  parts.lines.setAttribute('aria-live', 'polite');
  for (const node of [parts.meta, parts.notice, parts.lines, parts.ending]) pane.appendChild(node);
  PARTS.set(pane, parts);
  return pane;
}

export function patchRunOutputPane(pane: HTMLElement, view: RunOutputView): void {
  const parts = PARTS.get(pane);
  if (parts === undefined) return;
  setText(parts.meta, metaOf(view));
  setText(parts.notice, view.notice);
  setHidden(parts.notice, view.notice === '');
  reconcile(
    parts.lines,
    // The absolute line number: stable across an append AND across the cap dropping the front,
    // which is what makes a long run cost one new node per line instead of a redraw.
    view.lines.map((text, index) => ({ key: String(view.dropped + index), data: text })),
    () => el('div', 'run-output-line'),
    (node, text) => setText(node, text),
  );
  setText(parts.ending, view.ending ?? '');
  setHidden(parts.ending, view.ending === null);
}
