import type { SessionFileSystem } from '../../src/fs/session-file-system';

export class InMemoryFileSystem implements SessionFileSystem {
  private files = new Map<string, string>();
  private dirs = new Set<string>();

  private parentOf(path: string): string {
    const idx = path.lastIndexOf('/');
    return idx <= 0 ? '/' : path.slice(0, idx);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    if (options?.recursive) {
      const segments = path.split('/').filter(Boolean);
      let current = '';
      for (const segment of segments) {
        current += `/${segment}`;
        this.dirs.add(current);
      }
      return;
    }
    const parent = this.parentOf(path);
    if (!this.dirs.has(parent)) {
      throw new Error(`ENOENT: no such directory: ${parent}`);
    }
    this.dirs.add(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    const parent = this.parentOf(path);
    if (!this.dirs.has(parent)) {
      throw new Error(`ENOENT: no such directory: ${parent}`);
    }
    this.files.set(path, content);
  }

  async readFile(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`ENOENT: no such file: ${path}`);
    }
    return content;
  }

  async rename(from: string, to: string): Promise<void> {
    const content = this.files.get(from);
    if (content === undefined) {
      throw new Error(`ENOENT: no such file: ${from}`);
    }
    this.files.delete(from);
    this.files.set(to, content);
  }

  async readdir(path: string): Promise<string[]> {
    if (!this.dirs.has(path)) {
      throw new Error(`ENOENT: no such directory: ${path}`);
    }
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const names = new Set<string>();
    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(prefix)) {
        const rest = filePath.slice(prefix.length);
        const [firstSegment] = rest.split('/');
        if (firstSegment) names.add(firstSegment);
      }
    }
    for (const dirPath of this.dirs) {
      if (dirPath.startsWith(prefix) && dirPath !== path) {
        const rest = dirPath.slice(prefix.length);
        const [firstSegment] = rest.split('/');
        if (firstSegment) names.add(firstSegment);
      }
    }
    return [...names];
  }
}
