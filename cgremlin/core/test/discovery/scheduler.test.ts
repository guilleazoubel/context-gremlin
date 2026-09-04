import { describe, expect, it } from 'vitest';
import { DiscoveryScheduler, TickInProgressError, type Clock } from '../../src/discovery/scheduler';
import type { TickReport } from '../../src/discovery/reconciliation';

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeReport(overrides: Partial<TickReport> = {}): TickReport {
  return { reconciled: 0, actions: [], skipped: [], created: [], started: [], ignoredOwn: 0, errors: [], ...overrides };
}

class FakeClock implements Clock {
  private callback: (() => void) | null = null;
  private handle = { id: Symbol('fake-interval') };
  registrationCount = 0;
  lastIntervalMs: number | null = null;

  setInterval(fn: () => void, ms: number): unknown {
    this.registrationCount += 1;
    this.callback = fn;
    this.lastIntervalMs = ms;
    return this.handle;
  }

  clearInterval(handle: unknown): void {
    if (handle === this.handle) {
      this.callback = null;
    }
  }

  fire(): void {
    this.callback?.();
  }
}

class FakeTick {
  calls = 0;
  private next: (() => Promise<TickReport>) | null = null;

  setNext(fn: () => Promise<TickReport>): void {
    this.next = fn;
  }

  run(): Promise<TickReport> {
    this.calls += 1;
    const fn = this.next;
    this.next = null;
    return fn ? fn() : Promise.resolve(makeReport());
  }
}

describe('DiscoveryScheduler', () => {
  it('start registers exactly one interval with the configured intervalMs, and calling start again is a no-op', () => {
    const clock = new FakeClock();
    const tick = new FakeTick();
    const scheduler = new DiscoveryScheduler(tick, 5000, clock);
    scheduler.start();
    scheduler.start();
    expect(clock.registrationCount).toBe(1);
    expect(clock.lastIntervalMs).toBe(5000);
  });

  it('firing the interval runs the tick and updates lastReport', async () => {
    const clock = new FakeClock();
    const tick = new FakeTick();
    tick.setNext(() => Promise.resolve(makeReport({ reconciled: 2 })));
    const scheduler = new DiscoveryScheduler(tick, 1000, clock);
    scheduler.start();
    clock.fire();
    await flush();
    expect(tick.calls).toBe(1);
    expect(scheduler.lastReport?.reconciled).toBe(2);
  });

  it('firing again while a tick is still pending does not start a second tick, and increments skippedBeats', async () => {
    const clock = new FakeClock();
    const tick = new FakeTick();
    const d = deferred<TickReport>();
    tick.setNext(() => d.promise);
    const scheduler = new DiscoveryScheduler(tick, 1000, clock);
    scheduler.start();
    clock.fire();
    clock.fire();
    expect(tick.calls).toBe(1);
    expect(scheduler.skippedBeats).toBe(1);
    d.resolve(makeReport({ reconciled: 3 }));
    await flush();
    expect(scheduler.lastReport?.reconciled).toBe(3);
  });

  it('stop clears the interval so a later fire has no effect', () => {
    const clock = new FakeClock();
    const tick = new FakeTick();
    const scheduler = new DiscoveryScheduler(tick, 1000, clock);
    scheduler.start();
    scheduler.stop();
    clock.fire();
    expect(tick.calls).toBe(0);
  });

  it('isRunning reflects whether the scheduler has been started', () => {
    const clock = new FakeClock();
    const tick = new FakeTick();
    const scheduler = new DiscoveryScheduler(tick, 1000, clock);
    expect(scheduler.isRunning()).toBe(false);
    scheduler.start();
    expect(scheduler.isRunning()).toBe(true);
    scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
  });

  it('runNow throws TickInProgressError while a tick is pending, without calling tick.run again', async () => {
    const clock = new FakeClock();
    const tick = new FakeTick();
    const d = deferred<TickReport>();
    tick.setNext(() => d.promise);
    const scheduler = new DiscoveryScheduler(tick, 1000, clock);
    scheduler.start();
    clock.fire();
    await expect(scheduler.runNow()).rejects.toThrow(TickInProgressError);
    expect(tick.calls).toBe(1);
    d.resolve(makeReport());
    await flush();
  });

  it('runNow runs a tick immediately, returns the report, and updates lastReport', async () => {
    const clock = new FakeClock();
    const tick = new FakeTick();
    tick.setNext(() => Promise.resolve(makeReport({ reconciled: 5 })));
    const scheduler = new DiscoveryScheduler(tick, 1000, clock);
    const report = await scheduler.runNow();
    expect(tick.calls).toBe(1);
    expect(report.reconciled).toBe(5);
    expect(scheduler.lastReport).toEqual(report);
  });

  it('a rejecting tick is caught, recorded as lastError, and the scheduler keeps running', async () => {
    const clock = new FakeClock();
    const tick = new FakeTick();
    tick.setNext(() => Promise.reject(new Error('boom')));
    const scheduler = new DiscoveryScheduler(tick, 1000, clock);
    scheduler.start();
    clock.fire();
    await flush();
    expect(scheduler.lastError).toContain('boom');
    expect(scheduler.isRunning()).toBe(true);

    tick.setNext(() => Promise.resolve(makeReport({ reconciled: 1 })));
    clock.fire();
    await flush();
    expect(scheduler.lastReport?.reconciled).toBe(1);
    // X2: a later successful tick must clear the stale error, not leave it
    // reported forever.
    expect(scheduler.lastError).toBeNull();
  });
});
