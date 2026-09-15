/**
 * Phase 17 §1/§5b — the ticket, as its own pane, and its prose AS PROSE.
 *
 * The defect was not a rendering decision anyone made: the description was a literal
 * `el('pre','ticket-description')` with a code-block background, so every Jira ticket read as a
 * dump. `renderInline` had existed for exactly this and was never called. It is called here, and
 * the code-block styling now applies only to a real fenced block — a Jira code sample still
 * renders as code, and ONLY as code.
 *
 * The pane carries no heading: MG-17a, the tab names it and the header prints the title once.
 *
 * Runs in a browser context (R40).
 */
import type { TabTicket } from '../../model/item-tab-protocol';
import { renderInline } from '../markdown';
import { el, reconcile, setHidden, setHtml, setText } from './dom';

interface Parts {
  error: HTMLElement;
  meta: HTMLElement;
  description: HTMLElement;
  newest: HTMLElement;
  earlier: HTMLElement;
  earlierSummary: HTMLElement;
  earlierList: HTMLElement;
}

const PARTS = new WeakMap<HTMLElement, Parts>();

function comment(): HTMLElement {
  const entry = el('div', 'ticket-comment');
  entry.appendChild(el('div', 'ticket-comment-author'));
  entry.appendChild(el('div', 'ticket-comment-body'));
  return entry;
}

type Comment = TabTicket['comments'][number];

function patchComment(entry: HTMLElement, one: Comment): void {
  setText(entry.children[0] as HTMLElement, `${one.author} · ${one.at}`);
  setHtml(entry.children[1] as HTMLElement, renderInline(one.bodyText ?? ''));
}

export function createTicketPane(): HTMLElement {
  const pane = el('section', 'pane ticket-pane');
  const earlier = el('details', 'earlier-comments');
  const earlierSummary = el('summary');
  const earlierList = el('div', 'earlier-list');
  earlier.appendChild(earlierSummary);
  earlier.appendChild(earlierList);
  const parts: Parts = {
    // The failed read, where there was one. It is the whole pane in that case.
    error: el('p', 'error'),
    meta: el('p', 'ticket-meta'),
    description: el('div', 'ticket-description'),
    // §1: the earlier comments read ABOVE the newest, so the column runs oldest to newest.
    earlier,
    earlierSummary,
    earlierList,
    newest: el('div', 'newest-comment'),
  };
  pane.appendChild(parts.error);
  pane.appendChild(parts.meta);
  pane.appendChild(parts.description);
  pane.appendChild(parts.earlier);
  pane.appendChild(parts.newest);
  PARTS.set(pane, parts);
  return pane;
}

/**
 * §5d: the display name, and the account id as the honest fallback.
 *
 * `UAT · 712020:f0ac…` was the screenshot. The id is never hidden — where the wire carries no
 * name, the id is what the tab actually knows, and saying nothing would be worse.
 */
function metaOf(ticket: TabTicket): string {
  const who = ticket.assigneeName ?? ticket.assignee ?? '';
  return who === '' ? ticket.status : `${ticket.status} · ${who}`;
}

/**
 * The ticket, or — where the host could not read it — the reason, which IS the pane.
 *
 * `ticketError` used to reach the state and stop there: the Ticket part was dropped and nothing
 * said why, so a Jira outage looked like an item with no ticket.
 */
export function patchTicketPane(
  pane: HTMLElement,
  ticket: TabTicket | null,
  error: string | null,
): void {
  const parts = PARTS.get(pane);
  if (parts === undefined) return;
  setHidden(parts.error, error === null);
  setText(parts.error, error ?? '');
  for (const node of [parts.meta, parts.description, parts.newest]) {
    setHidden(node, ticket === null);
  }
  if (ticket === null) {
    setHidden(parts.earlier, true);
    return;
  }
  setText(parts.meta, metaOf(ticket));
  setHtml(parts.description, renderInline(ticket.descriptionText ?? ''));

  // The engine serves the comments newest first (`orderBy: -created`).
  const [newest, ...earlier] = ticket.comments;
  reconcile(
    parts.newest,
    newest === undefined ? [] : [{ key: 'newest', data: newest }],
    comment,
    patchComment,
  );
  setHidden(parts.earlier, earlier.length === 0);
  setText(
    parts.earlierSummary,
    `${earlier.length} earlier comment${earlier.length === 1 ? '' : 's'}`,
  );
  reconcile(
    parts.earlierList,
    earlier.map((one, at) => ({ key: `${at}`, data: one })),
    comment,
    patchComment,
  );
}
