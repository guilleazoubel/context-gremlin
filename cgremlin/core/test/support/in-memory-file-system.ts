import type { SessionFileSystem } from '../../src/fs/session-file-system';

const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIR_MODE = 0o755;

interface MemFile {
  content: string;
  mode: number;
}

export class InMemoryFileSystem implements SessionFileSystem {
  private files = new Map<string, MemFile>();
  private dirs = new Map<string, number>();

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
        if (!this.dirs.has(current)) this.dirs.set(current, DEFAULT_DIR_MODE);
      }
      return;
    }
    const parent = this.parentOf(path);
    if (!this.dirs.has(parent)) {
      throw new Error(`ENOENT: no such directory: ${parent}`);
    }
    if (!this.dirs.has(path)) this.dirs.set(path, DEFAULT_DIR_MODE);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path);
  }

  async writeFile(path: string, content: string, options?: { mode?: number }): Promise<void> {
    const parent = this.parentOf(path);
    if (!this.dirs.has(parent)) {
      throw new Error(`ENOENT: no such directory: ${parent}`);
    }
    const mode = options?.mode ?? this.files.get(path)?.mode ?? DEFAULT_FILE_MODE;
    this.files.set(path, { content, mode });
  }

  async readFile(path: string): Promise<string> {
    const file = this.files.get(path);
    if (file === undefined) {
      throw new Error(`ENOENT: no such file: ${path}`);
    }
    return file.content;
  }

  async statMode(path: string): Promise<number | null> {
    const file = this.files.get(path);
    if (file !== undefined) return file.mode & 0o777;
    const dirMode = this.dirs.get(path);
    if (dirMode !== undefined) return dirMode & 0o777;
    return null;
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async rename(from: string, to: string): Promise<void> {
    const file = this.files.get(from);
    if (file === undefined) {
      throw new Error(`ENOENT: no such file: ${from}`);
    }
    this.files.delete(from);
    this.files.set(to, file);
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
    for (const dirPath of this.dirs.keys()) {
      if (dirPath.startsWith(prefix) && dirPath !== path) {
        const rest = dirPath.slice(prefix.length);
        const [firstSegment] = rest.split('/');
        if (firstSegment) names.add(firstSegment);
      }
    }
    return [...names];
  }
}
