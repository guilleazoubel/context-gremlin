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
  stop(): Promise<EngineState>;
  restart(trigger?: Trigger): Promise<EngineState>;
  /** `GET /version`'s `activeRuns`, or `null` when nothing answered (R21). */
  activeRuns(): Promise<number | null>;
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
export const SHOW_LOG = 'Show log';
export const OPEN_CONFIG = 'Open core.json';
export const SETTINGS = 'Settings';
export const STOP_ENGINE = 'Stop the engine';
export const OPEN_LOG = 'Open the log file';

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
  private tailOffset = 0;
  private tailedLogPath: string | null = null;
  private unsubscribe: (() => void) | null = null;
  /** R2: a mismatch is asked about (or acted on) once per window, not once per state emission. */
  private mismatchHandled = false;
  private foreignWarned = false;
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
    const gh = await host
      .spawnCapture('gh', ['api', 'user', '--jq', '.login'], { timeoutMs: GH_TIMEOUT_MS })
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

  /** R27: validate first, re-assert the mode, and only then consult R21's gate. */
  private async onConfigSaved(configPath: string): Promise<void> {
    const { host, manager } = this.deps;
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
    try {
      await host.chmod(configPath, CONFIG_MODE);
    } catch (err) {
      host.log(`cgremlin: could not re-assert 0600 on ${configPath}: ${errorMessage(err)}`);
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
    // The warning is once per *episode*, not once per window: a socket that stopped being foreign
    // and became foreign again is news, and the manager re-probes rather than latching.
    if (state.kind !== 'foreign') this.foreignWarned = false;
    const status: EngineStatus =
      state.kind === 'stopping' ? { kind: state.kind, elapsedMs: state.elapsedMs } : { kind: state.kind };
    for (const listener of [...this.stateListeners]) listener(status);
    this.deps.host.appendOutput(`cgremlin engine: ${describe(state)}`);
    if (state.kind === 'starting' || state.kind === 'running') this.startTail();
    if (state.kind === 'mismatch') this.pending.track(this.handleMismatch(state));
    if (state.kind === 'foreign') this.pending.track(this.handleForeign());
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

  private async handleForeign(): Promise<void> {
    if (this.foreignWarned) return;
    this.foreignWarned = true;
    const answer = await this.deps.host.showWarningMessage(
      'Another server answers on the cgremlin socket. cgremlin will not start, stop or restart it.',
      undefined,
      SHOW_LOG,
      SETTINGS,
    );
    if (answer === SHOW_LOG) await this.showLog();
    else if (answer === SETTINGS) {
      await this.deps.host.executeCommand('workbench.action.openSettings', 'cgremlin');
    }
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
    await manager.stop();
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
      return `stopping (pid ${state.pid}, ${Math.round(state.elapsedMs / 1000)}s)`;
    case 'mismatch':
      return `version mismatch: running ${state.running}, bundled ${state.bundled}`;
    case 'failed':
      return `failed: ${state.reason}`;
    default:
      return state.kind;
  }
}
