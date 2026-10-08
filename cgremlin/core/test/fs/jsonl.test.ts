import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { JSONL_FILE_MODE, appendJsonLine, readJsonLines } from '../../src/fs/jsonl';

const Rec = z.object({ n: z.number() });

describe('jsonl', () => {
  it('creates the file and its directory at 0600, one line per append, and reads them back', async () => {
    const fs = new InMemoryFileSystem();
    await appendJsonLine(fs, '/state/x.jsonl', { n: 1 });
    await appendJsonLine(fs, '/state/x.jsonl', { n: 2 });
    expect(await fs.readFile('/state/x.jsonl')).toBe('{"n":1}\n{"n":2}\n');
    expect(await fs.statMode('/state/x.jsonl')).toBe(JSONL_FILE_MODE);
    expect(await readJsonLines(fs, '/state/x.jsonl', Rec)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('never glues a record onto a torn last line, and the reader skips torn, blank and foreign lines', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/state', { recursive: true });
    await fs.writeFile('/state/x.jsonl', '{"n":1}\n\n{"n":"two"}\n{"n":3');
    await appendJsonLine(fs, '/state/x.jsonl', { n: 4 });
    expect(await fs.readFile('/state/x.jsonl')).toBe('{"n":1}\n\n{"n":"two"}\n{"n":3\n{"n":4}\n');
    expect(await readJsonLines(fs, '/state/x.jsonl', Rec)).toEqual([{ n: 1 }, { n: 4 }]);
  });

  it('a missing file reads as no records', async () => {
    expect(await readJsonLines(new InMemoryFileSystem(), '/nope/x.jsonl', Rec)).toEqual([]);
  });

  it('a rename that fails reports the error and leaves no temporary file behind', async () => {
    const fs = new InMemoryFileSystem();
    await appendJsonLine(fs, '/state/x.jsonl', { n: 1 });
    fs.rename = async () => {
      throw new Error('disk full');
    };
    await expect(appendJsonLine(fs, '/state/x.jsonl', { n: 2 })).rejects.toThrow('disk full');
    expect(await fs.readdir('/state')).toEqual(['x.jsonl']);
    expect(await readJsonLines(fs, '/state/x.jsonl', Rec)).toEqual([{ n: 1 }]);
  });

  it('leaves no temporary file behind', async () => {
    const fs = new InMemoryFileSystem();
    await appendJsonLine(fs, '/state/x.jsonl', { n: 1 });
    expect(await fs.readdir('/state')).toEqual(['x.jsonl']);
  });
});
