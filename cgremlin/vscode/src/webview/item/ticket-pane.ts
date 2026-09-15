/**
 * Phase 17 §1 — the ticket, as its own pane.
 *
 * Runs in a browser context (R40).
 */
import type { TabTicket } from '../../model/item-tab-protocol';
import { el, reconcile, setText } from './dom';

interface Parts {
  meta: HTMLElement;
  description: HTMLElement;
  comments: HTMLElement;
}

const PARTS = new WeakMap<HTMLElement, Parts>();

export function createTicketPane(): HTMLElement {
  const pane = el('section', 'pane ticket-pane');
  const meta = el('p', 'ticket-meta');
  const description = el('pre', 'ticket-description');
  const comments = el('div', 'ticket-comments');
  pane.appendChild(meta);
  pane.appendChild(description);
  pane.appendChild(comments);
  PARTS.set(pane, { meta, description, comments });
  return pane;
}

export function patchTicketPane(pane: HTMLElement, ticket: TabTicket): void {
  const parts = PARTS.get(pane);
  if (parts === undefined) return;
  setText(
    parts.meta,
    `${ticket.status}${ticket.assignee === null ? '' : ` · ${ticket.assignee}`}`,
  );
  setText(parts.description, ticket.descriptionText ?? '');
  reconcile(
    parts.comments,
    ticket.comments.map((comment, at) => ({ key: `${at}`, data: comment })),
    () => {
      const entry = el('div', 'ticket-comment');
      entry.appendChild(el('div', 'ticket-comment-author'));
      entry.appendChild(el('pre', 'ticket-comment-body'));
      return entry;
    },
    (entry, comment) => {
      setText(entry.children[0] as HTMLElement, `${comment.author} · ${comment.at}`);
      setText(entry.children[1] as HTMLElement, comment.bodyText ?? '');
    },
  );
}
