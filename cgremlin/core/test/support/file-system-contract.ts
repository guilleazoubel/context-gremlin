import { describe, expect, it } from 'vitest';
import type { SessionFileSystem } from '../../src/fs/session-file-system';

export function testFileSystemContract(
  label: string,
  createFs: () => SessionFileSystem | Promise<SessionFileSystem>,
  makePath: (...segments: string[]) => string,
): void {
  describe(`${label} (SessionFileSystem contract)`, () => {
    it('writes and reads back a file', async () => {
      const fs = await createFs();
      const path = makePath('a.txt');
      await fs.writeFile(path, 'hello');
      expect(await fs.readFile(path)).toBe('hello');
    });

    it('exists() is false for a path never written', async () => {
      const fs = await createFs();
      expect(await fs.exists(makePath('missing.txt'))).toBe(false);
    });

    it('exists() is true after writeFile', async () => {
      const fs = await createFs();
      const path = makePath('b.txt');
      await fs.writeFile(path, 'x');
      expect(await fs.exists(path)).toBe(true);
    });

    it('rename moves content from one path to another', async () => {
      const fs = await createFs();
      const from = makePath('c-tmp.txt');
      const to = makePath('c.txt');
      await fs.writeFile(from, 'moved');
      await fs.rename(from, to);
      expect(await fs.exists(from)).toBe(false);
      expect(await fs.readFile(to)).toBe('moved');
    });

    it('mkdir then readdir lists a file written inside it', async () => {
      const fs = await createFs();
      const dir = makePath('dir1');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(makePath('dir1', 'child.txt'), 'y');
      const entries = await fs.readdir(dir);
      expect(entries).toContain('child.txt');
    });

    it('readFile on a missing path rejects', async () => {
      const fs = await createFs();
      await expect(fs.readFile(makePath('nope.txt'))).rejects.toThrow();
    });

    it('mkdir with recursive:true also makes ancestor directories exist', async () => {
      const fs = await createFs();
      await fs.mkdir(makePath('deep', 'nested', 'dir'), { recursive: true });
      expect(await fs.exists(makePath('deep'))).toBe(true);
      expect(await fs.exists(makePath('deep', 'nested'))).toBe(true);
    });

    it('writeFile into a non-existent parent directory rejects', async () => {
      const fs = await createFs();
      await expect(fs.writeFile(makePath('missing-dir', 'file.txt'), 'x')).rejects.toThrow();
    });

    it('mkdir without recursive rejects when the parent does not exist', async () => {
      const fs = await createFs();
      await expect(fs.mkdir(makePath('a', 'b', 'c'))).rejects.toThrow();
    });

    it('readdir on a non-existent directory rejects', async () => {
      const fs = await createFs();
      await expect(fs.readdir(makePath('does-not-exist'))).rejects.toThrow();
    });
  });
}
