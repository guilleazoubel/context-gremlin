/**
 * The engine, as the user meets it: four commands, the status bar's engine half, the first-run
 * bootstrap, the log tail and the config watcher.
 *
 * Every decision that can cancel a user's work lives here or in `engine/manager.ts`, never in
 * `extension.ts` — which is why both are unit-tested against a fake editor surface. Two rules run
 * through the file:
 *  - **`GET /version`'s `activeRuns` is the only input to a restart decision** (R21). Zero means
 *    restart and log one line; more than zero means a *modal* question, because a restart stops
 *    every active run (`core/src/host/serve.ts:180-211`). The panel's PR-level listing is not
 *    consulted: it describes pull requests, not the engine's own in-flight work.
 *  - **the engine's own wording is shown verbatim** (the rule `ui/commands.ts` already follows):
 *    a `ConfigError` from the bundled loader is the engine's message, not a paraphrase of it.
 */
import {
  RE_PROBE,
  SHOW_LOG,
  healthOf,
  troubleMessage,
  type EngineHealth,
} from '../model/engine-trouble';
import type { ResolvedEnginePaths, EngineBridge } from '../engine/bridge';
import type { EngineState, Trigger } from '../engine/manager';
import type { DisposableLike, Host } from './host';
import type { EngineStatus } from './status-bar';
import { PendingWork } from './host';

/** What this surface needs from the manager; a structural type so tests can hand it a fake. */
export interface EngineManagerLike {
  state(): EngineState;
  onStateChange(cb: (state: EngineState) => void): () => void;
  ensureRunning(trigger?: Trigger): Promise<EngineState>;
  stop(trigger?: Trigger): Promise<EngineState>;
  restart(trigger?: Trigger): Promise<EngineState>;
  /** `GET /version`'s `activeRuns`, or `null` when nothing answered (R21). */
  activeRuns(): Promise<number | null>;
  /** `GET /version`'s `startedAt`, or `null` when nothing answered — R26b's cross-window check. */
  engineStartedAt(): Promise<string | null>;
}

/**
 * The half of the engine surface the panel's Refresh command needs: what the engine is doing,
 * and a way to ask again. A structural type so `ui/commands.ts` does not depend on the class.
 */
export interface EngineHealthSource {
  health(): EngineHealth;
  reprobe(): Promise<void>;
}

export interface EngineSurfaceDeps {
  host: Host;
  manager: EngineManagerLike;
  bridge: EngineBridge;
  /** `cgremlin.configPath`, read live. */
  configPath: () => string;
  home: string;
  /** The Node host and the bundled engine, for `config init` (R5). */
  execPath: string;
  enginePath: string;
  /**
   * R20's login-shell `PATH`, the same resolution the engine's own spawn uses. `null` when the
   * shell did not answer, and then the spawn below simply inherits this process's environment.
   */
  resolveLoginPath: () => Promise<string | null>;
  /** Re-attach the event stream and refetch — used when the socket moves (D5). */
  reconnect: () => Promise<void>;
  /** The debounce on a `core.json` save (R6). */
  debounceMs?: number;
}

const DEBOUNCE_MS = 500;
const GH_TIMEOUT_MS = 5_000;
const CONFIG_MODE = 0o600;

export const RESTART = 'Restart engine';
export const NOT_NOW = 'Not now';
export const OPEN_CONFIG = 'Open core.json';
export const STOP_ENGINE = 'Stop the engine';
export const OPEN_LOG = 'Open the log file';
// The two actions an unusable engine offers are the package's shared wording, re-exported here
// because every caller of this surface already imports its action labels from it.
export { RE_PROBE, SHOW_LOG };

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : '';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class EngineSurface {
  private readonly pending = new PendingWork();
  private readonly stateListeners = new Set<(status: EngineStatus) => void>();
  private resolved: ResolvedEnginePaths | null = null;
  private watchedConfigPath: string | null = null;
  private configWatch: DisposableLike | null = null;
  private logWatch: DisposableLike | null = null;
  private cancelDebounce: (() => void) | null = null;
  /**
   * The content address of the `core.json` this surface has already acted on — seeded wherever
   * the config is resolved, and the only thing that turns a watch *event* into a config *change*.
   */
  private lastConfigDigest: string | null = null;
  private tailOffset = 0;
  private tailedLogPath: string | null = null;
  private unsubscribe: (() => void) | null = null;
  /** R2: a mismatch is asked about (or acted on) once per window, not once per state emission. */
  private mismatchHandled = false;
  /**
   * The kind the last emission carried. The foreign warning is *edge*-triggered off this: every
   * transition into `foreign` is news, however many episodes there are, while a socket that is
   * still foreign is not news again. A once-per-window latch was the old behaviour, and it is
   * exactly how a user comes to be staring at four empty lists with no explanation.
   */
  private lastKind: EngineState['kind'] = 'unknown';
  /**
   * Set when the engine answered the socket but is not one this extension can talk to — a
   * `GET /config` that 404s, which is what an engine older than that route does. The manager
   * cannot see it: it probes `GET /version` only, so this is the client layer telling the
   * surface the same fact by hand. Cleared by the manager's next word on the subject.
   */
  private unusable = false;
  private disposed = false;

  constructor(private readonly deps: EngineSurfaceDeps) {
    this.unsubscribe = deps.manager.onStateChange((state) => this.onEngineState(state));
  }

  /** The paths the engine's own loader derived. The socket provider reads this (R7, MG-C6). */
  paths(): ResolvedEnginePaths | null {
    return this.resolved;
  }

  onState(cb: (status: EngineStatus) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  /** What the engine is doing, as the panel, the status bar and Refresh all read it. */
  health(): EngineHealth {
    if (this.unusable) return { kind: 'foreign', socketPath: this.socketPath() };
    return healthOf(this.deps.manager.state(), this.socketPath());
  }

  /** Ask the socket again. The manager adopts whatever answers, so this is the way out. */
  async reprobe(): Promise<void> {
    await this.deps.manager.ensureRunning('user');
  }

  /**
   * The engine answered, and is not one we can use (`GET /config` 404s on an engine that predates
   * the route). Surfaced exactly as a `foreign` probe is — same row, same status bar, same
   * popup — because to the user it is the same problem with the same fix.
   */
  reportUnusable(): void {
    const previous = this.lastKind;
    this.unusable = true;
    this.lastKind = 'foreign';
    const status: EngineHealth = { kind: 'foreign', socketPath: this.socketPath() };
    this.publish(status);
    this.deps.host.appendOutput(
      'cgremlin engine: something answers the socket but does not speak this engine\u2019s API.',
    );
    if (previous !== 'foreign') this.pending.track(this.warnForeign(status));
  }

  private socketPath(): string | null {
    return this.resolved?.socketPath ?? null;
  }

  private publish(status: EngineStatus): void {
    for (const listener of [...this.stateListeners]) listener(status);
  }

  register(): DisposableLike[] {
    const { host } = this.deps;
    return [
      host.registerCommand('cgremlin.engine.start', async () => {
        await this.deps.manager.ensureRunning('user');
      }),
      host.registerCommand('cgremlin.engine.stop', async () => {
        await this.confirmAndStop();
      }),
      host.registerCommand('cgremlin.engine.restart', async () => {
        await this.deps.manager.restart('user');
      }),
      host.registerCommand('cgremlin.engine.showLog', async () => {
        await this.showLog();
      }),
    ];
  }

  /**
   * Activation (R15): create `core.json` if it is not there, resolve it through the engine's own
   * loader, arm the watcher, start the engine, and only then let the rest of the extension
   * connect — connecting first is what produced the misleading "not running" warning.
   */
  async bootstrap(): Promise<void> {
    const configPath = this.deps.configPath();
    if (!this.deps.host.fileExists(configPath)) {
      const created = await this.firstRun(configPath);
      if (!created) return;
    }
    if (!(await this.resolveConfig(configPath))) return;
    this.armConfigWatcher(configPath);
    const state = await this.deps.manager.ensureRunning();
    // An adopted engine never emits `starting`, so the tail is started here as well as from a
    // state change — always after `ensureRunning`, never before it (R30's rotate → spawn → tail).
    this.startTail();
    if (state.kind === 'running') await this.deps.reconnect();
  }

  /** D5: the setting changed. The engine we were talking to is left alone (R16). */
  async settingsChanged(): Promise<void> {
    const configPath = this.deps.configPath();
    if (configPath === this.watchedConfigPath) return;
    if (!(await this.resolveConfig(configPath))) return;
    this.armConfigWatcher(configPath);
    await this.deps.reconnect();
    await this.deps.manager.ensureRunning();
  }

  settled(): Promise<void> {
    return this.pending.settled();
  }

  /** R30: both watches go, and the engine keeps running (R16). */
  dispose(): void {
    this.disposed = true;
    this.cancelDebounce?.();
    this.cancelDebounce = null;
    this.configWatch?.dispose();
    this.configWatch = null;
    this.logWatch?.dispose();
    this.logWatch = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.stateListeners.clear();
  }

  // --- config -------------------------------------------------------------

  private async resolveConfig(configPath: string): Promise<boolean> {
    try {
      this.resolved = await this.deps.bridge.loadResolvedConfig(configPath, this.deps.home);
      this.lastConfigDigest = this.deps.host.fileDigest(configPath);
      return true;
    } catch (err) {
      this.reportConfigFailure(configPath, err);
      return false;
    }
  }

  private reportConfigFailure(configPath: string, err: unknown): void {
    if (errorName(err) === 'ConfigError') {
      this.pending.track(this.offerToOpen(errorMessage(err), configPath));
      return;
    }
    this.deps.host.appendOutput(`cgremlin: could not read ${configPath}: ${errorMessage(err)}`);
  }

  private async offerToOpen(message: string, configPath: string): Promise<void> {
    const answer = await this.deps.host.showWarningMessage(message, undefined, OPEN_CONFIG);
    if (answer === OPEN_CONFIG) await this.deps.host.openTextDocument(configPath);
  }

  /** R5: the core writes the template; the extension only supplies a real login. */
  private async firstRun(configPath: string): Promise<boolean> {
    const { host } = this.deps;
    const me = await this.askWhoTheyAre();
    if (me === undefined) {
      await host.showWarningMessage(
        `No GitHub login, so ${configPath} was not created. Set cgremlin.configPath to an existing file, or run the command again.`,
        undefined,
      );
      return false;
    }
    const result = await host.spawnCapture(this.deps.execPath, [
      this.deps.enginePath,
      'config',
      'init',
      '--config',
      configPath,
      '--me',
      me,
    ]);
    if (result.code !== 0) {
      await host.showWarningMessage(
        result.stderr.trim() === '' ? `Could not create ${configPath}.` : result.stderr.trim(),
        undefined,
      );
      return false;
    }
    await host.openTextDocument(configPath);
    this.pending.track(
      host
        .showInformationMessage(
          `Created ${configPath}. Add the repos you want cgremlin to watch; the engine restarts when you save.`,
          undefined,
        )
        .then(() => undefined),
    );
    return true;
  }

  private async askWhoTheyAre(): Promise<string | undefined> {
    const { host } = this.deps;
    // `gh` is very often only on the login shell's PATH — Homebrew's, typically — which the
    // editor's own environment need not carry. Resolving it the way the engine's spawn does is
    // the difference between "gh: not found" and knowing who the user is on the first run (R20).
    const loginPath = await this.deps.resolveLoginPath().catch(() => null);
    const gh = await host
      .spawnCapture('gh', ['api', 'user', '--jq', '.login'], {
        timeoutMs: GH_TIMEOUT_MS,
        env: loginPath === null ? undefined : { PATH: loginPath },
      })
      .catch(() => ({ code: 1, stdout: '', stderr: '' }));
    const login = gh.code === 0 ? gh.stdout.trim() : '';
    if (login !== '') return login;
    const typed = await host.showInputBox({
      title: 'Your GitHub login',
      prompt: 'cgremlin needs it to tell your pull requests from everyone else’s.',
      ignoreFocusOut: true,
    });
    const trimmed = typed?.trim() ?? '';
    return trimmed === '' ? undefined : trimmed;
  }

  private armConfigWatcher(configPath: string): void {
    this.configWatch?.dispose();
    this.watchedConfigPath = configPath;
    this.configWatch = this.deps.host.watchFile(configPath, () => this.onConfigTouched(configPath));
  }

  private onConfigTouched(configPath: string): void {
    this.cancelDebounce?.();
    this.cancelDebounce = this.deps.host.setTimeout(() => {
      this.cancelDebounce = null;
      if (this.disposed) return;
      this.pending.track(this.onConfigSaved(configPath));
    }, this.deps.debounceMs ?? DEBOUNCE_MS);
  }

  /**
   * R27: read the bytes first, validate, re-assert the mode only if it is wrong, and only then
   * consult R21's gate.
   *
   * The first step is not optional politeness. `fs.watch` reports events, not changes, and on
   * macOS a `chmod` on the watched file *is* an event — so a pass that chmods unconditionally
   * feeds itself the next event and the watcher restarts the engine forever, at the period of one
   * restart. An event whose digest matches the content already acted on therefore ends the pass
   * here: before the chmod, and before any restart decision.
   *
   * R26b, extended across windows: the once-per-identity auto-restart latch in `EngineManager` is
   * per *window*, so two windows each restart the one shared engine for a single save (window A
   * restarts pid1 → pid2; window B, having never latched pid2 itself, restarts it again → pid3).
   * Before consulting R21's gate, this checks whether the *running* engine already postdates the
   * save: `engine.startedAt >= configPath`'s own mtime means some window (this one or another) has
   * already restarted it for these exact bytes, and there is nothing left to do.
   */
  private async onConfigSaved(configPath: string): Promise<void> {
    const { host, manager } = this.deps;
    const digest = host.fileDigest(configPath);
    // A digest we cannot take (the file is gone mid-save) is not proof of sameness, so it falls
    // through to the validate below, which is where a missing file gets its message.
    if (digest !== null && digest === this.lastConfigDigest) return;
    // Latched before the validate, not after: a config that does not load is still a config we
    // have seen, and re-running the same failure for every event the save produced adds nothing.
    this.lastConfigDigest = digest;
    let resolved: ResolvedEnginePaths;
    try {
      resolved = await this.deps.bridge.loadResolvedConfig(configPath, this.deps.home);
    } catch (err) {
      // The engine is left completely alone, and the watcher stays armed: the next save is the
      // user's fix attempt, and a watcher that disarmed itself on a typo would go silently dead.
      this.reportConfigFailure(configPath, err);
      return;
    }
    this.resolved = resolved;
    // R27's re-assertion, narrowed to the case that needs it: a `chmod` that changes nothing is
    // still a filesystem event, and this watcher is the thing listening for it.
    if (host.fileMode(configPath) !== CONFIG_MODE) {
      try {
        await host.chmod(configPath, CONFIG_MODE);
      } catch (err) {
        host.log(`cgremlin: could not re-assert 0600 on ${configPath}: ${errorMessage(err)}`);
      }
    }
    const mtimeMs = host.fileMtimeMs(configPath);
    if (mtimeMs !== null) {
      const startedAt = await manager.engineStartedAt();
      if (startedAt !== null && new Date(startedAt).getTime() >= mtimeMs) {
        host.log(
          `engine.restart_skipped_fresh: the running engine started at ${startedAt}, at or after ${configPath}'s last change; it already has these bytes.`,
        );
        return;
      }
    }
    const active = await manager.activeRuns();
    if (active === null) {
      await manager.ensureRunning();
      return;
    }
    if (active === 0) {
      host.appendOutput(`cgremlin: ${configPath} changed and nothing was running — restarting.`);
      await manager.restart();
      return;
    }
    const answer = await host.showInformationMessage(
      `${configPath} changed. Restarting the engine stops ${active} running item(s).`,
      { modal: true },
      RESTART,
      NOT_NOW,
    );
    if (answer === RESTART) await manager.restart();
  }

  // --- state, prompts and the log -----------------------------------------

  private onEngineState(state: EngineState): void {
    const previous = this.lastKind;
    // The manager has just spoken about the socket; whatever the client layer reported about it
    // before is superseded.
    this.unusable = false;
    this.lastKind = state.kind;
    const status = healthOf(state, this.socketPath());
    this.publish(status);
    this.deps.host.appendOutput(`cgremlin engine: ${describe(state)}`);
    if (state.kind === 'starting' || state.kind === 'running' || state.kind === 'outdated') {
      this.startTail();
    }
    if (state.kind === 'mismatch') this.pending.track(this.handleMismatch(state));
    // Edge-triggered, and every edge: entering `foreign` again after the socket was usable is
    // news again, and a socket that has been foreign all along is not.
    if (state.kind === 'foreign' && previous !== 'foreign') {
      this.pending.track(this.warnForeign(status));
    }
    // The way out of the explanatory row: the probe adopted a usable engine, so the panel goes
    // back to being a panel — which it can only do once it has refetched.
    if (
      (state.kind === 'running' || state.kind === 'outdated') &&
      (previous === 'foreign' || previous === 'failed')
    ) {
      this.pending.track(this.deps.reconnect());
    }
  }

  /** R2 as amended by R21: ask only when there is something to lose. */
  private async handleMismatch(state: EngineState & { kind: 'mismatch' }): Promise<void> {
    if (this.mismatchHandled) return;
    this.mismatchHandled = true;
    const { host, manager } = this.deps;
    const active = (await manager.activeRuns()) ?? 0;
    if (active === 0) {
      host.appendOutput(
        `cgremlin engine: the running engine is ${state.running} and this extension ships ${state.bundled}; nothing is running, so it is being restarted.`,
      );
      await manager.restart();
      return;
    }
    const answer = await host.showInformationMessage(
      `The running cgremlin engine is version ${state.running}; this extension ships ${state.bundled}. Restarting stops ${active} running item(s).`,
      { modal: true },
      RESTART,
      NOT_NOW,
      SHOW_LOG,
    );
    if (answer === RESTART) await manager.restart('user');
    else if (answer === SHOW_LOG) await this.showLog();
  }

  /** The same sentence the panel's row and the status bar's tooltip show, plus its two actions. */
  private async warnForeign(status: EngineHealth): Promise<void> {
    const answer = await this.deps.host.showWarningMessage(
      troubleMessage({ kind: 'foreign', socketPath: status.socketPath ?? null }),
      undefined,
      RE_PROBE,
      SHOW_LOG,
    );
    if (answer === RE_PROBE) await this.reprobe();
    else if (answer === SHOW_LOG) await this.showLog();
  }

  /** R16/R21: the engine is shared by every window, and stopping it cancels what is running. */
  private async confirmAndStop(): Promise<void> {
    const { host, manager } = this.deps;
    if (manager.state().kind === 'stopping') {
      host.appendOutput('cgremlin engine: already stopping; waiting for it to finish.');
      return;
    }
    const active = (await manager.activeRuns()) ?? 0;
    const answer = await host.showWarningMessage(
      `The cgremlin engine is shared by every window. Stopping it stops ${active} running item(s).`,
      { modal: true },
      STOP_ENGINE,
    );
    if (answer !== STOP_ENGINE) return;
    // A person asked, in a modal, and said yes: the engine honours that whatever build it is on.
    await manager.stop('user');
  }

  private async showLog(): Promise<void> {
    const { host } = this.deps;
    host.showOutput();
    const logPath = this.resolved?.engineLogPath;
    if (logPath === undefined) return;
    const answer = await host.showInformationMessage(`The engine logs to ${logPath}.`, undefined, OPEN_LOG);
    if (answer === OPEN_LOG) await host.openTextDocument(logPath);
  }

  /**
   * R11/R30: the tail starts at the *current* end of file, so activation does not replay
   * yesterday's log, and it is (re)started after the spawn — never before the rotate.
   */
  private startTail(): void {
    const logPath = this.resolved?.engineLogPath;
    if (logPath === undefined || this.tailedLogPath === logPath) return;
    this.logWatch?.dispose();
    this.tailedLogPath = logPath;
    this.tailOffset = this.deps.host.fileSize(logPath);
    this.logWatch = this.deps.host.watchFile(logPath, () => this.drainTail(logPath));
  }

  private drainTail(logPath: string): void {
    if (this.disposed) return;
    const size = this.deps.host.fileSize(logPath);
    // A rotation (R11) replaces the file: start again from its beginning rather than from an
    // offset that now points into the middle of a different file.
    if (size < this.tailOffset) this.tailOffset = 0;
    const { text, end } = this.deps.host.readFileSlice(logPath, this.tailOffset);
    this.tailOffset = end;
    for (const line of text.split('\n')) {
      if (line !== '') this.deps.host.appendOutput(line);
    }
  }
}

function describe(state: EngineState): string {
  switch (state.kind) {
    case 'running':
      return `running ${state.version} (pid ${state.pid}${state.adopted ? ', adopted' : ''})`;
    case 'stopping':
      return `stopping (pid ${state.pid ?? 'unknown'}, ${Math.round(state.elapsedMs / 1000)}s)`;
    case 'mismatch':
      return `version mismatch: running ${state.running}, bundled ${state.bundled}`;
    case 'outdated':
      return `this window is behind the engine: running ${state.running}, bundled ${state.bundled} — reload the window`;
    case 'failed':
      return `failed: ${state.reason}`;
    default:
      return state.kind;
  }
}
