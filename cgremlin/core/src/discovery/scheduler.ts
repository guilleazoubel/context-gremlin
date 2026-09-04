import type { TickReport } from './reconciliation';

export interface Clock {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface Tickable {
  run(): Promise<TickReport>;
}

export class TickInProgressError extends Error {
  constructor() {
    super('A discovery tick is already in progress');
    this.name = 'TickInProgressError';
  }
}

export class DiscoveryScheduler {
  private handle: unknown = null;
  private pending: Promise<TickReport> | null = null;
  private _lastReport: TickReport | null = null;
  private _lastError: string | null = null;
  private _skippedBeats = 0;

  constructor(
    private readonly tick: Tickable,
    private readonly intervalMs: number,
    private readonly clock: Clock = globalThis as unknown as Clock,
  ) {}

  get lastReport(): TickReport | null {
    return this._lastReport;
  }

  get lastError(): string | null {
    return this._lastError;
  }

  get skippedBeats(): number {
    return this._skippedBeats;
  }

  isRunning(): boolean {
    return this.handle !== null;
  }

  start(): void {
    if (this.handle !== null) return;
    this.handle = this.clock.setInterval(() => this.fire(), this.intervalMs);
  }

  stop(): void {
    if (this.handle !== null) {
      this.clock.clearInterval(this.handle);
      this.handle = null;
    }
  }

  private fire(): void {
    if (this.pending !== null) {
      this._skippedBeats += 1;
      return;
    }
    const p = this.runTick();
    this.pending = p;
    // Nobody awaits an interval-triggered tick; mark it handled so a
    // (guarded-against but always-possible) rejection never surfaces as an
    // unhandled promise rejection.
    p.catch(() => undefined);
  }

  private async runTick(): Promise<TickReport> {
    try {
      const report = await this.tick.run();
      this._lastReport = report;
      return report;
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.pending = null;
    }
  }

  async runNow(): Promise<TickReport> {
    if (this.pending !== null) {
      throw new TickInProgressError();
    }
    const p = this.runTick();
    this.pending = p;
    return p;
  }
}
