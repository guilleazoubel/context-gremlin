/**
 * A change to one session artifact on disk. The watcher never reads file
 * *contents* — the consumer does.
 */
export interface SessionWatchEvent {
  sessionId: string;
  name: string;
}

export interface SessionWatcher {
  start(onChange: (e: SessionWatchEvent) => void): void;
  stop(): void;
}
