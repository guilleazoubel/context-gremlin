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
  constructor(id: string, reason: string) {
    super(`Session '${id}' is corrupt: ${reason}`);
    this.name = 'SessionCorruptError';
  }
}

export class SessionStore {
  constructor(
    private readonly fs: SessionFileSystem,
    private readonly sessionsDir: string,
  ) {}

  private sessionDirPath(id: string): string {
    return `${this.sessionsDir}/${id}`;
  }

  private sessionFilePath(id: string): string {
    return `${this.sessionDirPath(id)}/session.json`;
  }

  async save(session: Session): Promise<void> {
    const validated = parseSession(session);
    const dir = this.sessionDirPath(validated.id);
    await this.fs.mkdir(dir, { recursive: true });
    const finalPath = this.sessionFilePath(validated.id);
    const tmpPath = `${finalPath}.tmp`;
    await this.fs.writeFile(tmpPath, JSON.stringify(validated, null, 2));
    await this.fs.rename(tmpPath, finalPath);
  }

  async load(id: string): Promise<Session> {
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
      throw new SessionCorruptError(id, `invalid JSON: ${(err as Error).message}`);
    }
    try {
      return parseSession(parsed);
    } catch (err) {
      throw new SessionCorruptError(id, `schema validation failed: ${(err as Error).message}`);
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
      sessions.push(await this.load(id));
    }
    return sessions;
  }

  async transition(id: string, to: string): Promise<Session> {
    const session = await this.load(id);
    const updated = applyTransition(session, to);
    await this.save(updated);
    return updated;
  }
}
