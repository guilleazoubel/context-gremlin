import { describe, expect, it } from 'vitest';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import type { SessionFileSystem } from '../../src/fs/session-file-system';
import { JiraStore } from '../../src/jira/jira-store';
import { JiraScanner } from '../../src/jira/jira-scanner';
import { JiraAuthError, JiraUnavailableError, type JiraIssueSummary, type JiraSource } from '../../src/jira/jira-source';

const NOW = new Date('2026-09-10T12:00:00.000Z');
const PATH = '/state/jira.json';
const JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';

function issue(key: string): JiraIssueSummary {
  return {
    key,
    summary: `summary of ${key}`,
    status: 'In Progress',
    statusCategory: 'indeterminate',
    assignee: '712020:me',
    updated: '2026-09-09T10:00:00.000+0000',
    url: `https://aplaceformom.atlassian.net/browse/${key}`,
  };
}

class FakeJiraSource implements JiraSource {
  readonly calls: string[] = [];
  whoamiCalls = 0;
  searchCalls = 0;
  constructor(
    private readonly behaviour: {
      issues?: JiraIssueSummary[];
      searchError?: unknown;
      whoamiError?: unknown;
      hang?: boolean;
    } = {},
  ) {}

  async whoami(opts?: { signal?: AbortSignal }): Promise<{ accountId: string; displayName: string }> {
    this.whoamiCalls += 1;
    this.calls.push('whoami');
    if (this.behaviour.whoamiError !== undefined) throw this.behaviour.whoamiError;
    await this.maybeHang(opts?.signal);
    return { accountId: '712020:me', displayName: 'Me' };
  }

  async search(_jql: string, opts?: { signal?: AbortSignal }): Promise<JiraIssueSummary[]> {
    this.searchCalls += 1;
    this.calls.push('search');
    if (this.behaviour.searchError !== undefined) throw this.behaviour.searchError;
    await this.maybeHang(opts?.signal);
    return this.behaviour.issues ?? [];
  }

  async issue(): Promise<never> {
    throw new Error('unused');
  }

  private async maybeHang(signal?: AbortSignal): Promise<void> {
    if (this.behaviour.hang !== true) return;
    await new Promise<void>((_resolve, reject) => {
      if (signal === undefined) return;
      signal.addEventListener('abort', () => reject(new JiraUnavailableError('aborted')), { once: true });
    });
  }
}

function scanner(source: JiraSource | null, fs = new InMemoryFileSystem(), scanBudgetMs = 20_000) {
  const store = new JiraStore(fs, PATH);
  return {
    fs,
    store,
    scanner: new JiraScanner({ source, store, jql: JQL, scanBudgetMs, now: () => NOW }),
  };
}

describe('JiraScanner: the four kinds (R35)', () => {
  it('with no source at all the report is notConfigured and NOTHING is requested', async () => {
    const { scanner: s } = scanner(null);
    const report = await s.run();
    expect(report).toEqual({ scannedAt: NOW.toISOString(), me: null, issues: [], error: null, kind: 'notConfigured' });
  });

  it('a 401/403 gives kind auth', async () => {
    const src = new FakeJiraSource({ whoamiError: new JiraAuthError('Client must be authenticated', 401) });
    const { scanner: s } = scanner(src);
    const report = await s.run();
    expect(report.kind).toBe('auth');
    expect(report.error).toContain('Client must be authenticated');
  });

  it('a timeout, 5xx or malformed body gives kind unavailable', async () => {
    const src = new FakeJiraSource({ searchError: new JiraUnavailableError('Jira responded 500 for /search') });
    const { scanner: s } = scanner(src);
    const report = await s.run();
    expect(report.kind).toBe('unavailable');
    expect(report.error).toContain('500');
  });

  it('a successful scan is kind ok', async () => {
    const { scanner: s } = scanner(new FakeJiraSource({ issues: [issue('HB-627')] }));
    const report = await s.run();
    expect(report.kind).toBe('ok');
    expect(report.error).toBeNull();
    expect(report.issues.map((i) => i.key)).toEqual(['HB-627']);
  });

  it('there is no `configured` boolean on the report', async () => {
    const { scanner: s } = scanner(null);
    expect(Object.keys(await s.run()).sort()).toEqual(['error', 'issues', 'kind', 'me', 'scannedAt']);
  });
});

describe('JiraScanner: degradation (MG-6)', () => {
  it('a throwing source leaves the previously written jira.json unchanged and still on disk, and returns its tickets', async () => {
    const fs = new InMemoryFileSystem();
    const first = scanner(new FakeJiraSource({ issues: [issue('HB-627')] }), fs);
    await first.scanner.run();
    const onDisk = await fs.readFile(PATH);

    const second = scanner(new FakeJiraSource({ searchError: new JiraUnavailableError('boom') }), fs);
    const report = await second.scanner.run();

    expect(report.kind).toBe('unavailable');
    expect(report.error).not.toBeNull();
    // NOT [] — an empty myWork reads as "you have no work".
    expect(report.issues.map((i) => i.key)).toEqual(['HB-627']);
    expect(await fs.readFile(PATH)).toBe(onDisk);
  });
});

describe('JiraScanner: whoami and the cache file (R37, MG-5)', () => {
  it('resolves me from whoami() exactly once per scan and puts the accountId on the report', async () => {
    const src = new FakeJiraSource({ issues: [issue('HB-627')] });
    const { scanner: s } = scanner(src);
    const report = await s.run();
    expect(report.me).toBe('712020:me');
    expect(src.whoamiCalls).toBe(1);
    expect(src.searchCalls).toBe(1);
  });

  it('writes jira.json tmp-then-rename and the file holds no token and no Authorization value', async () => {
    const fs = new InMemoryFileSystem();
    const renames: Array<{ from: string; to: string }> = [];
    const spied: SessionFileSystem = {
      readFile: (p) => fs.readFile(p),
      writeFile: (p, c, o) => fs.writeFile(p, c, o),
      statMode: (p) => fs.statMode(p),
      statMtimeMs: (p) => fs.statMtimeMs(p),
      remove: (p) => fs.remove(p),
      rename: (from, to) => {
        renames.push({ from, to });
        return fs.rename(from, to);
      },
      readdir: (p) => fs.readdir(p),
      mkdir: (p, o) => fs.mkdir(p, o),
      exists: (p) => fs.exists(p),
    };
    const store = new JiraStore(spied, PATH);
    const s = new JiraScanner({ source: new FakeJiraSource({ issues: [issue('HB-627')] }), store, jql: JQL, scanBudgetMs: 20_000, now: () => NOW });
    await s.run();

    expect(renames.length).toBe(1);
    expect(renames[0].to).toBe(PATH);
    expect(renames[0].from).toMatch(/\.tmp$/);
    const text = await fs.readFile(PATH);
    expect(text.toLowerCase()).not.toContain('authorization');
    expect(text.toLowerCase()).not.toContain('apitoken');
    expect((await fs.readdir('/state')).some((n) => n.endsWith('.tmp'))).toBe(false);
  });

  it('lastReport() comes from jira.json on a cold start', async () => {
    const fs = new InMemoryFileSystem();
    await scanner(new FakeJiraSource({ issues: [issue('HB-627')] }), fs).scanner.run();
    const cold = scanner(new FakeJiraSource(), fs).scanner;
    const last = await cold.lastReport();
    expect(last.issues.map((i) => i.key)).toEqual(['HB-627']);
    expect(last.kind).toBe('ok');
  });

  it('lastReport() with no cache at all is notConfigured-shaped and empty', async () => {
    const { scanner: s } = scanner(null);
    const last = await s.lastReport();
    expect(last.issues).toEqual([]);
    expect(last.kind).toBe('notConfigured');
  });
});

describe('JiraScanner: single flight and the budget (R34)', () => {
  it('a run starting during an in-flight leg starts no second leg', async () => {
    const src = new FakeJiraSource({ hang: true });
    const { scanner: s } = scanner(src, new InMemoryFileSystem(), 30);
    const a = s.run();
    const b = s.run();
    expect(s.inFlight()).not.toBeNull();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe(rb);
    expect(src.whoamiCalls).toBe(1);
    expect(s.inFlight()).toBeNull();
  });

  it('a leg exceeding scanBudgetMs is aborted and recorded as unavailable, never thrown', async () => {
    const src = new FakeJiraSource({ hang: true });
    const { scanner: s } = scanner(src, new InMemoryFileSystem(), 25);
    const report = await s.run();
    expect(report.kind).toBe('unavailable');
    expect(report.error).not.toBeNull();
  });

  it('ONE AbortController spans whoami and every page', async () => {
    let whoamiSignal: AbortSignal | undefined;
    let searchSignal: AbortSignal | undefined;
    const src: JiraSource = {
      whoami: async (opts) => {
        whoamiSignal = opts?.signal;
        return { accountId: '712020:me', displayName: 'Me' };
      },
      search: async (_jql, opts) => {
        searchSignal = opts?.signal;
        return [];
      },
      issue: async () => {
        throw new Error('unused');
      },
    };
    await scanner(src).scanner.run();
    expect(whoamiSignal).toBeDefined();
    expect(searchSignal).toBe(whoamiSignal);
  });
});
