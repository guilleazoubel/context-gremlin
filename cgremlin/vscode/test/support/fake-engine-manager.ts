/**
 * A recording stand-in for `EngineManager`, and for the engine bundle's bridge.
 *
 * The manager's own behaviour is proved in `test/engine/manager.test.ts`; what the wiring tests
 * need is only to know *whether* the surface asked for a start, a stop or a restart, and with
 * which trigger — because "it restarted without asking" is the bug that cancels a user's work.
 */
import type { EngineBridge, ResolvedEnginePaths } from '../../src/engine/bridge';
import type { EngineState, Trigger } from '../../src/engine/manager';
import type { EngineManagerLike } from '../../src/ui/engine';

export const FAKE_PATHS: ResolvedEnginePaths = {
  configPath: '/home/me/.cgremlin-core/core.json',
  stateDir: '/home/me/.cgremlin-core',
  socketPath: '/home/me/.cgremlin-core/engine.sock',
  sessionsDir: '/home/me/.cgremlin-core/sessions',
  worktreesDir: '/home/me/.cgremlin-core/worktrees',
  enginePidPath: '/home/me/.cgremlin-core/engine.json',
  engineLogPath: '/home/me/.cgremlin-core/engine.log',
  repos: [],
  me: 'someone',
};

export class ConfigErrorLike extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class FakeBridge implements EngineBridge {
  ENGINE_VERSION = '0.0.1';
  ENGINE_BUILD_ID = 'fakebuildid00000';
  paths: ResolvedEnginePaths = FAKE_PATHS;
  /** Thrown by the next `loadResolvedConfig` call, then cleared. */
  failWith: Error | null = null;
  readonly loads: string[] = [];

  async loadResolvedConfig(configPath: string): Promise<ResolvedEnginePaths> {
    this.loads.push(configPath);
    const failure = this.failWith;
    if (failure !== null) {
      this.failWith = null;
      throw failure;
    }
    return { ...this.paths, configPath };
  }
}

export class FakeEngineManager implements EngineManagerLike {
  readonly calls: string[] = [];
  current: EngineState = { kind: 'unknown' };
  /** What `GET /version` reports; `null` means nothing answered. */
  runs: number | null = 0;
  /** `GET /version`'s `startedAt`, as `engineStartedAt()` answers it; `null` means nothing answered. */
  startedAt: string | null = null;
  /**
   * What `startedAt` becomes the moment `restart()` is called — simulating the engine really
   * restarting, for a test that drives two `EngineSurface`s over this one fake engine. `undefined`
   * (the default) leaves `startedAt` untouched, which is what every test that does not care about
   * R26b's cross-window freshness check wants.
   */
  startedAtAfterRestart: string | undefined;
  private readonly listeners = new Set<(state: EngineState) => void>();

  state(): EngineState {
    return this.current;
  }

  onStateChange(cb: (state: EngineState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async ensureRunning(trigger: Trigger = 'auto'): Promise<EngineState> {
    this.calls.push(`ensureRunning:${trigger}`);
    return this.current;
  }

  async stop(): Promise<EngineState> {
    this.calls.push('stop');
    return this.current;
  }

  async restart(trigger: Trigger = 'auto'): Promise<EngineState> {
    this.calls.push(`restart:${trigger}`);
    if (this.startedAtAfterRestart !== undefined) this.startedAt = this.startedAtAfterRestart;
    return this.current;
  }

  async activeRuns(): Promise<number | null> {
    this.calls.push('activeRuns');
    return this.runs;
  }

  async engineStartedAt(): Promise<string | null> {
    this.calls.push('engineStartedAt');
    return this.startedAt;
  }

  /** Pushes a state the way the real manager does. */
  emit(state: EngineState): void {
    this.current = state;
    for (const listener of [...this.listeners]) listener(state);
  }

  countOf(call: string): number {
    return this.calls.filter((c) => c === call).length;
  }
}
