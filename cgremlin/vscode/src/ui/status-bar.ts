/**
 * The status bar, which names the session whose worktree the managed workspace currently holds
 * (R15 makes that the only way to know which repo you are looking at).
 *
 * `N need you` is `items.filter(i => i.attention.needsYou).length` — the core's own flag (R22), the
 * same number the popup predicate uses, so the badge and the popups can never disagree.
 */
import type { Host, StatusBarItemLike } from './host';

export interface StatusBarState {
  connected: boolean;
  needYou: number;
  currentSessionId: string | null;
  currentPhase: string | null;
  currentWorktreePath: string | null;
}

export function statusBarText(state: StatusBarState): string {
  if (!state.connected) return '$(circle-slash) cgremlin: offline';
  if (state.currentSessionId === null) {
    return `$(folder) cgremlin: no repo open — ${state.needYou} need you`;
  }
  const phase = state.currentPhase ?? 'unknown';
  return `$(pulse) cgremlin: ${state.currentSessionId} · ${phase} — ${state.needYou} need you`;
}

export function statusBarTooltip(state: StatusBarState): string {
  if (!state.connected) return 'The cgremlin engine is not reachable on its socket.';
  return [
    state.currentWorktreePath === null
      ? 'No session worktree is open yet.'
      : `Worktree: ${state.currentWorktreePath}`,
    `${state.needYou} item(s) need you.`,
  ].join('\n');
}

/** Offline, the click starts the engine; online, it reveals the panel. */
export function statusBarCommand(state: StatusBarState): string {
  return state.connected ? 'workbench.view.extension.cgremlin' : 'cgremlin.startEngine';
}

export class StatusBar {
  private readonly item: StatusBarItemLike;

  constructor(host: Host) {
    this.item = host.createStatusBarItem();
    this.render({
      connected: false,
      needYou: 0,
      currentSessionId: null,
      currentPhase: null,
      currentWorktreePath: null,
    });
    this.item.show();
  }

  render(state: StatusBarState): void {
    this.item.text = statusBarText(state);
    this.item.tooltip = statusBarTooltip(state);
    this.item.command = statusBarCommand(state);
  }

  dispose(): void {
    this.item.dispose();
  }
}
