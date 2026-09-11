/**
 * The status bar, which names the session whose worktree the managed workspace currently holds
 * (R15 makes that the only way to know which repo you are looking at).
 *
 * `N need you` is `items.filter(i => i.attention.needsYou).length` — the core's own flag (R22), the
 * same number the popup predicate uses, so the badge and the popups can never disagree.
 */
import {
  troubleCommand,
  troubleOf,
  troubleStatusText,
  troubleMessage,
  type EngineHealth,
  type SourceTrouble,
} from '../model/engine-trouble';
import type { Host, StatusBarItemLike } from './host';

/**
 * R17/R23: what the engine manager last said, for how long it has been saying it, and — for the
 * two states that owe the user an explanation — the socket and the reason the wording needs.
 */
export type EngineStatus = EngineHealth;

export interface StatusBarState {
  connected: boolean;
  /** The engine answered but could not list the work — shown when the engine itself is fine. */
  sourceTrouble: SourceTrouble | null;
  needYou: number;
  currentSessionId: string | null;
  currentPhase: string | null;
  currentWorktreePath: string | null;
  engine: EngineStatus;
}

/** What the refresh pipeline knows. The engine half arrives separately, from the manager. */
export type DomainStatus = Omit<StatusBarState, 'engine'>;

/**
 * R17: the engine state is shown only when it is *not* simply healthy — an engine that is running
 * is the normal case and the bar keeps saying what the user actually cares about. `unknown` is the
 * moment before the manager has answered, and reads as the old offline text.
 */
export function engineText(engine: EngineStatus): string | null {
  switch (engine.kind) {
    case 'starting':
      return '$(sync~spin) cgremlin: starting…';
    case 'stopping':
      return `$(sync~spin) cgremlin: stopping… ${Math.round((engine.elapsedMs ?? 0) / 1000)}s`;
    case 'stopped':
      return '$(circle-slash) cgremlin: engine stopped';
    case 'mismatch':
      return '$(warning) cgremlin: engine version mismatch';
    default: {
      // `foreign` and `failed` are the two states the whole package words in one place.
      const trouble = troubleOf(engine);
      return trouble === null ? null : troubleStatusText(trouble);
    }
  }
}

/** R17: the two states that are not simply news are painted in the editor's warning colour. */
export function statusBarWarning(state: StatusBarState): boolean {
  return troubleOf(state.engine) !== null || state.sourceTrouble !== null;
}

export function statusBarText(state: StatusBarState): string {
  const engine = engineText(state.engine);
  if (engine !== null) return engine;
  // One explanation at a time, and the engine's own is the more fundamental of the two.
  if (state.sourceTrouble !== null) return state.sourceTrouble.statusText;
  if (!state.connected) return '$(circle-slash) cgremlin: offline';
  if (state.currentSessionId === null) {
    return `$(folder) cgremlin: no repo open — ${state.needYou} need you`;
  }
  const phase = state.currentPhase ?? 'unknown';
  return `$(pulse) cgremlin: ${state.currentSessionId} · ${phase} — ${state.needYou} need you`;
}

export function statusBarTooltip(state: StatusBarState): string {
  const trouble = troubleOf(state.engine);
  if (trouble !== null) return troubleMessage(trouble);
  if (engineText(state.engine) !== null) return 'The cgremlin engine — click to see the log.';
  if (state.sourceTrouble !== null) return state.sourceTrouble.message;
  if (!state.connected) return 'The cgremlin engine is not reachable on its socket.';
  return [
    state.currentWorktreePath === null
      ? 'No session worktree is open yet.'
      : `Worktree: ${state.currentWorktreePath}`,
    `${state.needYou} item(s) need you.`,
  ].join('\n');
}

/**
 * A stopped or failed engine is one click from starting; one that is mid-flight is one click from
 * its log; a healthy one reveals the panel (R17).
 */
export function statusBarCommand(state: StatusBarState): string {
  const trouble = troubleOf(state.engine);
  // A stranger on the socket is one click from a re-probe (the user has just stopped the old
  // engine); a failure is one click from the log that says why.
  if (trouble !== null) return troubleCommand(trouble);
  if (state.sourceTrouble !== null) return state.sourceTrouble.command;
  switch (state.engine.kind) {
    case 'stopped':
      return 'cgremlin.engine.start';
    case 'starting':
    case 'stopping':
    case 'mismatch':
      return 'cgremlin.engine.showLog';
    default:
      return state.connected ? 'workbench.view.extension.cgremlin' : 'cgremlin.engine.start';
  }
}

export class StatusBar {
  private readonly item: StatusBarItemLike;
  private domain: DomainStatus = {
    connected: false,
    needYou: 0,
    currentSessionId: null,
    currentPhase: null,
    currentWorktreePath: null,
    sourceTrouble: null,
  };
  private engine: EngineStatus = { kind: 'unknown' };

  constructor(host: Host) {
    this.item = host.createStatusBarItem();
    this.paint();
    this.item.show();
  }

  render(state: DomainStatus): void {
    this.domain = state;
    this.paint();
  }

  /** The engine half, pushed by `ui/engine.ts` as the manager changes state. */
  setEngine(engine: EngineStatus): void {
    this.engine = engine;
    this.paint();
  }

  private paint(): void {
    const state: StatusBarState = { ...this.domain, engine: this.engine };
    this.item.text = statusBarText(state);
    this.item.tooltip = statusBarTooltip(state);
    this.item.command = statusBarCommand(state);
    this.item.warning = statusBarWarning(state);
  }

  dispose(): void {
    this.item.dispose();
  }
}
