export interface SessionFileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string, options?: { mode?: number }): Promise<void>;
  /** Permission bits only (`mode & 0o777`); `null` when the path does not exist. */
  statMode(path: string): Promise<number | null>;
  /** Deletes a file; a no-op when the path does not exist. */
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;
}
