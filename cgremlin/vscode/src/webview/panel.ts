/**
 * The side panel's webview entry (R54).
 *
 * B2 lands the handshake and the message plumbing so `build:webview` has its second entry point;
 * B4 and B5 build the rows, the groups, the sort control and the keyboard model on top of it.
 * Like the Item tab it owns no data and imports nothing from the editor module.
 */
import type { HostToPanel, PanelState } from '../model/panel-protocol';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const api = acquireVsCodeApi();

export function post(message: unknown): void {
  api.postMessage(message);
}

let state: PanelState | null = null;

export function current(): PanelState | null {
  return state;
}

export function apply(next: PanelState): void {
  state = next;
}

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as HostToPanel;
  if (message === null || typeof message !== 'object') return;
  if (message.type === 'render') apply(message.state);
  else if (message.type === 'patch' && state !== null) apply({ ...state, ...message.state });
});

// R39's handshake, for the same reason: a `render` posted before this listener exists is dropped
// silently and the panel stays blank.
post({ type: 'ready' });
