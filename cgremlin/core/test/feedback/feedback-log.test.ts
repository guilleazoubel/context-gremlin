import { describe, expect, it } from 'vitest';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { FeedbackLog, type FeedbackRecord } from '../../src/feedback/feedback-log';
import { JSONL_FILE_MODE } from '../../src/fs/jsonl';

const PATH = '/state/feedback.jsonl';

function rec(id: string): FeedbackRecord {
  return {
    v: 1, id, at: '2026-10-08T12:00:00.000Z', source: 'auto', kind: 'finding_dismissed', text: `t ${id}`,
    context: { sessionId: 's', mode: 'review', stage: null, ticket: null, pr: null, artifact: null, anchor: null },
    producedBy: null, detail: {},
  };
}

describe('FeedbackLog (§20)', () => {
  it('appendOnce writes a record once per id, in a 0600 file', async () => {
    const fs = new InMemoryFileSystem();
    const log = new FeedbackLog(fs, PATH);
    expect(await log.appendOnce(rec('a'))).toBe(true);
    expect(await log.appendOnce(rec('a'))).toBe(false);
    expect((await log.list()).map((r) => r.id)).toEqual(['a']);
    expect(await fs.statMode(PATH)).toBe(JSONL_FILE_MODE);
  });

  it('25 concurrent appends of distinct ids keep all 25', async () => {
    const log = new FeedbackLog(new InMemoryFileSystem(), PATH);
    const ids = Array.from({ length: 25 }, (_, i) => `id-${i}`);
    await Promise.all(ids.map((id) => log.appendOnce(rec(id))));
    expect((await log.list()).map((r) => r.id).sort()).toEqual([...ids].sort());
  });

  it('10 concurrent appends of the same id write it once', async () => {
    const log = new FeedbackLog(new InMemoryFileSystem(), PATH);
    const wrote = await Promise.all(Array.from({ length: 10 }, () => log.appendOnce(rec('same'))));
    expect(wrote.filter(Boolean)).toHaveLength(1);
    expect(await log.list()).toHaveLength(1);
  });

  it('a torn line from a crash is skipped by list(), and the next record lands on its own line', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/state', { recursive: true });
    await fs.writeFile(PATH, `${JSON.stringify(rec('a'))}\n{"v":1,"id":"torn`);
    const log = new FeedbackLog(fs, PATH);
    expect(await log.appendOnce(rec('b'))).toBe(true);
    expect((await log.list()).map((r) => r.id)).toEqual(['a', 'b']);
    expect((await fs.readFile(PATH)).split('\n')).toHaveLength(4);
  });

  it('refuses a malformed record instead of writing it', async () => {
    const log = new FeedbackLog(new InMemoryFileSystem(), PATH);
    await expect(log.appendOnce({ ...rec('x'), kind: 'nope' } as unknown as FeedbackRecord)).rejects.toThrow();
    expect(await log.list()).toEqual([]);
  });

  it('reads and writes only its own file — never core.json or anything else in the state dir', async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir('/state', { recursive: true });
    await fs.writeFile('/state/core.json', '{"jira":{"apiToken":"SECRET"}}');
    const touched: string[] = [];
    const realRead = fs.readFile.bind(fs);
    fs.readFile = async (p: string) => {
      touched.push(p);
      return realRead(p);
    };
    const log = new FeedbackLog(fs, PATH);
    await log.appendOnce(rec('a'));
    await log.appendOnce(rec('b'));
    await log.list();
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.every((p) => p === PATH)).toBe(true);
  });
});
