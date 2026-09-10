import type { SessionWatchEvent, SessionWatcher } from '../../src/fs/session-watcher';

/** The in-memory SessionWatcher every consumer test drives by hand. */
export class FakeSessionWatcher implements SessionWatcher {
  private onChange: ((e: SessionWatchEvent) => void) | null = null;
  started = false;
  stopped = false;

  start(onChange: (e: SessionWatchEvent) => void): void {
    if (this.started) {
      throw new Error('FakeSessionWatcher.start called twice');
    }
    this.started = true;
    this.onChange = onChange;
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    this.onChange = null;
  }

  emit(e: SessionWatchEvent): void {
    this.onChange?.(e);
  }
}
