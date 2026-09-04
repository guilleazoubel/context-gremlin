import { parseSession, type Session } from '../schema/session';
import type { SessionFileSystem } from '../fs/session-file-system';
import { applyTransition } from './session-transition';

export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`No session found with id '${id}'`);
    this.name = 'SessionNotFoundError';
  }
}

export class SessionCorruptError extends Error {
  constructor(id: string, reason: string, options?: { cause?: unknown }) {
    super(`Session '${id}' is corrupt: ${reason}`, options);
    this.name = 'SessionCorruptError';
  }
}

export class InvalidSessionIdError extends Error {
  constructor(id: string) {
    super(`Invalid session id '${id}': must not be empty, contain '/' or '\\', or be '.'/'..'`);
    this.name = 'InvalidSessionIdError';
  }
}

export function assertSafeSessionId(id: string): void {
  if (id.length === 0 || id.includes('/') || id.includes('\\') || id === '.' || id === '..') {
    throw new InvalidSessionIdError(id);
  }
}

function randomSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export class SessionStore {
  constructor(
    private readonly fs: SessionFileSystem,
    private readonly sessionsDir: string,
  ) {
    if (!sessionsDir.startsWith('/')) {
      throw new Error(`SessionStore requires an absolute sessionsDir, got: '${sessionsDir}'`);
    }
  }

  private sessionDirPath(id: string): string {
    return `${this.sessionsDir}/${id}`;
  }

  private sessionFilePath(id: string): string {
    return `${this.sessionDirPath(id)}/session.json`;
  }

  async save(session: Session): Promise<void> {
    const validated = parseSession(session);
    assertSafeSessionId(validated.id);
    const dir = this.sessionDirPath(validated.id);
    await this.fs.mkdir(dir, { recursive: true });
    const finalPath = this.sessionFilePath(validated.id);
    const tmpPath = `${finalPath}.${randomSuffix()}.tmp`;
    await this.fs.writeFile(tmpPath, JSON.stringify(validated, null, 2));
    await this.fs.rename(tmpPath, finalPath);
  }

  async load(id: string): Promise<Session> {
    assertSafeSessionId(id);
    const path = this.sessionFilePath(id);
    const exists = await this.fs.exists(path);
    if (!exists) {
      throw new SessionNotFoundError(id);
    }
    const raw = await this.fs.readFile(path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new SessionCorruptError(id, `invalid JSON: ${(err as Error).message}`, { cause: err });
    }
    try {
      return parseSession(parsed);
    } catch (err) {
      throw new SessionCorruptError(id, `schema validation failed: ${(err as Error).message}`, {
        cause: err,
      });
    }
  }

  async list(): Promise<Session[]> {
    const exists = await this.fs.exists(this.sessionsDir);
    if (!exists) {
      return [];
    }
    const entries = await this.fs.readdir(this.sessionsDir);
    const sessions: Session[] = [];
    for (const id of entries) {
      const isSession = await this.fs.exists(this.sessionFilePath(id));
      if (!isSession) {
        continue; // stray file/dir under sessionsDir that isn't a session (e.g. .dashboard_server.py)
      }
      try {
        sessions.push(await this.load(id));
      } catch (err) {
        if (err instanceof SessionCorruptError) {
          continue; // don't let one corrupt session take down the whole listing
        }
        throw err;
      }
    }
    return sessions.sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Loads the session, applies the transition, and persists the result.
   *
   * NOT safe against concurrent transition() calls for the same session id —
   * this is an unguarded read-modify-write. Phase 1c (the local API server)
   * MUST serialize concurrent requests per session id (e.g. an in-process
   * per-id async lock) before exposing this over HTTP; SessionStore itself
   * deliberately does not do this, since request-serialization is a
   * request-handling concern, not a persistence concern.
   */
  async transition(id: string, to: string): Promise<Session> {
    const session = await this.load(id);
    const updated = applyTransition(session, to);
    await this.save(updated);
    return updated;
  }
}
