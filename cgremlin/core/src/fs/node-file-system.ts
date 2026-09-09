import { promises as fs } from 'node:fs';
import type { SessionFileSystem } from './session-file-system';

export class NodeFileSystem implements SessionFileSystem {
  async readFile(path: string): Promise<string> {
    return fs.readFile(path, 'utf8');
  }

  async writeFile(path: string, content: string, options?: { mode?: number }): Promise<void> {
    await fs.writeFile(path, content, { encoding: 'utf8', ...(options?.mode !== undefined ? { mode: options.mode } : {}) });
    // fs.writeFile's `mode` only applies when it creates the file, and is
    // masked by the umask even then — chmod makes the requested mode exact,
    // which is what the 0600 secret guarantee depends on.
    if (options?.mode !== undefined) {
      await fs.chmod(path, options.mode);
    }
  }

  async statMode(path: string): Promise<number | null> {
    try {
      const stats = await fs.stat(path);
      return stats.mode & 0o777;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async remove(path: string): Promise<void> {
    await fs.rm(path, { force: true });
  }

  async rename(from: string, to: string): Promise<void> {
    await fs.rename(from, to);
  }

  async readdir(path: string): Promise<string[]> {
    return fs.readdir(path);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await fs.mkdir(path, options);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }
}
