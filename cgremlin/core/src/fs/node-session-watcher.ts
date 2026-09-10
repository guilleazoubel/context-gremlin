import { watch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { parseArtifactName } from '../api/validation';
import type { SessionWatchEvent, SessionWatcher } from './session-watcher';

const DEFAULT_POLL_INTERVAL_MS = 2000;
/** Duplicate `<id>/<name>` reports inside this window are one change. */
const COALESCE_MS = 100;

export interface NodeSessionWatcherOptions {
  pollIntervalMs?: number;
  /** A test seam: substitute (or break) `fs.watch` to exercise the poll path. */
  watchFactory?: (
    dir: string,
    options: { recursive: true },
    listener: (event: string, filename: string | null) => void,
  ) => FSWatcher;
}

/**
 * Watches `sessionsDir` recursively and maps a relative `"<sessionId>/<name>"`
 * path to a SessionWatchEvent.
 *
 * Verified on this machine (Node 24, darwin): a nested write reports
 * `["rename","s1/AGENT_STATE"]` *and* the directory's own basename as a bare
 * one-segment `change`, which is why anything that is not exactly two
 * segments is discarded. The name filter is `parseArtifactName` — the one
 * artifact allow-list — which already admits AGENT_STATE/AGENT_NOTE and
 * rejects `session.json`, `*.tmp` and everything under `logs/`.
 */
export class NodeSessionWatcher implements SessionWatcher {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private onChange: ((e: SessionWatchEvent) => void) | null = null;
  private readonly lastEmitted = new Map<string, number>();
  private readonly mtimes = new Map<string, number>();

  constructor(
    private readonly sessionsDir: string,
    private readonly opts: NodeSessionWatcherOptions = {},
  ) {}

  start(onChange: (e: SessionWatchEvent) => void): void {
    this.onChange = onChange;
    const factory =
      this.opts.watchFactory ??
      ((dir, options, listener) => watch(dir, options, listener));
    try {
      this.watcher = factory(this.sessionsDir, { recursive: true }, (_event, filename) => {
        if (filename === null) return;
        this.onWatchPath(filename);
      });
      // A watcher that dies later (the directory went away, the platform gave
      // up) must degrade rather than take the engine down with it.
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = null;
        this.startPolling();
      });
    } catch {
      // ENOSYS / ERR_FEATURE_UNAVAILABLE_ON_PLATFORM is the documented
      // no-recursive-watch case; every other failure (a sessions dir that
      // does not exist yet, for one) degrades the same way rather than
      // aborting engine boot. The poll scan swallows its own errors, so an
      // unwatchable directory simply reports nothing.
      this.startPolling();
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.onChange = null;
    this.lastEmitted.clear();
    this.mtimes.clear();
  }

  /**
   * Test seam: the `<sessionId>/<name>` pairs this watcher still remembers.
   * A long-lived engine sees sessions come and go, so this must not grow
   * without bound — the pruning below is what keeps it honest.
   */
  get trackedKeys(): string[] {
    return [...new Set([...this.lastEmitted.keys(), ...this.mtimes.keys()])].sort();
  }

  /**
   * A one-segment report is the sessions dir's own basename or a session
   * directory (created OR removed); a two-segment one is an artifact. Either
   * can mean "gone", which is when the remembered state for it is dropped.
   */
  private onWatchPath(relative: string): void {
    const segments = relative.split('/');
    if (segments.length === 1) {
      void this.forgetIfMissing(segments[0], null);
      return;
    }
    if (segments.length !== 2) return;
    this.report(relative);
    void this.forgetIfMissing(segments[0], segments[1]);
  }

  private async forgetIfMissing(sessionId: string, name: string | null): Promise<void> {
    if (sessionId.length === 0) return;
    const target =
      name === null
        ? `${this.sessionsDir}/${sessionId}`
        : `${this.sessionsDir}/${sessionId}/${name}`;
    try {
      await stat(target);
      return; // still there
    } catch {
      // gone: fall through
    }
    this.forget(name === null ? `${sessionId}/` : `${sessionId}/${name}`);
  }

  /** Drops every remembered key that is, or lives under, `prefix`. */
  private forget(prefix: string): void {
    for (const map of [this.lastEmitted, this.mtimes]) {
      for (const key of [...map.keys()]) {
        if (key === prefix || key.startsWith(prefix)) map.delete(key);
      }
    }
  }

  /** Keeps only `<sessionId>/<artifact>`, coalesced per pair. */
  private report(relative: string): void {
    const segments = relative.split('/');
    if (segments.length !== 2) return;
    const [sessionId, name] = segments;
    if (sessionId.length === 0 || name.length === 0) return;
    try {
      parseArtifactName(name);
    } catch {
      return;
    }
    const key = `${sessionId}/${name}`;
    const now = Date.now();
    const previous = this.lastEmitted.get(key);
    if (previous !== undefined && now - previous < COALESCE_MS) return;
    this.lastEmitted.set(key, now);
    this.onChange?.({ sessionId, name });
  }

  private startPolling(): void {
    if (this.timer !== null) return;
    // The first scan only records what is already there: a poll fallback must
    // not replay the whole sessions directory as "changes".
    void this.scan(false);
    this.timer = setInterval(() => void this.scan(true), this.opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.timer.unref();
  }

  private async scan(emit: boolean): Promise<void> {
    let ids: string[];
    try {
      ids = await readdir(this.sessionsDir);
    } catch {
      return;
    }
    const present = new Set<string>();
    for (const id of ids) {
      let names: string[];
      try {
        names = await readdir(`${this.sessionsDir}/${id}`);
      } catch {
        continue;
      }
      for (const name of names) {
        try {
          parseArtifactName(name);
        } catch {
          continue;
        }
        let mtimeMs: number;
        try {
          mtimeMs = (await stat(`${this.sessionsDir}/${id}/${name}`)).mtimeMs;
        } catch {
          continue;
        }
        const key = `${id}/${name}`;
        present.add(key);
        const previous = this.mtimes.get(key);
        this.mtimes.set(key, mtimeMs);
        if (emit && previous !== mtimeMs) this.report(key);
      }
    }
    // A session (or one of its artifacts) that vanished between scans is
    // forgotten, so neither map tracks the whole history of the engine.
    for (const map of [this.lastEmitted, this.mtimes]) {
      for (const key of [...map.keys()]) {
        if (!present.has(key)) map.delete(key);
      }
    }
  }
}
