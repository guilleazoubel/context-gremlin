import { promises as fs } from 'node:fs';
import type { SessionFileSystem } from './session-file-system';

export class NodeFileSystem implements SessionFileSystem {
  async readFile(path: string): Promise<string> {
    return fs.readFile(path, 'utf8');
  }

  async writeFile(path: string, content: string): Promise<void> {
    await fs.writeFile(path, content, 'utf8');
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
