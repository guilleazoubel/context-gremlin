import type { Clock } from '../../src/discovery/scheduler';

export class FakeClock implements Clock {
  private handle: { id: symbol } | null = null;
  private callback: (() => void) | null = null;
  registrationCount = 0;
  clearedCount = 0;
  lastIntervalMs: number | null = null;

  setInterval(fn: () => void, ms: number): unknown {
    this.registrationCount += 1;
    this.lastIntervalMs = ms;
    this.callback = fn;
    this.handle = { id: Symbol('fake-interval') };
    return this.handle;
  }

  clearInterval(handle: unknown): void {
    if (handle === this.handle) {
      this.clearedCount += 1;
      this.handle = null;
      this.callback = null;
    }
  }

  get isRunning(): boolean {
    return this.handle !== null;
  }

  fire(): void {
    this.callback?.();
  }
}
