/**
 * Phase 17 §3 — a `path:line` inside a review is an ADDRESS, so it opens the file.
 *
 * The contract makes this exact rather than heuristic: a finding's `Where` is code only, a
 * backticked repo-relative `path:line`, and nothing else. So the walk replaces exactly the
 * `<code>` elements `fileRefOf` answers on and leaves every other one alone — `npm run build`
 * stays a command, and a reference inside a fenced block is a code SAMPLE rather than an address.
 *
 * Runs in a browser context (R40).
 */
import { fileRefOf } from '../../model/artifact-outline';
import { post } from './channel';
import { walk } from './dom';

function refButton(text: string, path: string, line: number): HTMLElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'file-ref';
  node.textContent = text;
  node.addEventListener('click', () => post({ type: 'openFile', path, line }));
  return node;
}

export function linkFileRefs(body: HTMLElement): void {
  const candidates: HTMLElement[] = [];
  walk(body, (node) => {
    if (node.tagName !== 'CODE') return;
    // A fenced block is a sample of code, not a place in the repo.
    if (node.parentElement?.tagName === 'PRE') return;
    candidates.push(node);
  });
  for (const code of candidates) {
    const ref = fileRefOf(code.textContent ?? '');
    const parent = code.parentElement;
    if (ref === null || parent === null) continue;
    parent.insertBefore(refButton(code.textContent ?? '', ref.path, ref.line), code);
    parent.removeChild(code);
  }
}
