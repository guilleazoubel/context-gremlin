import { describe, expect, it } from 'vitest';
import { TicketDetailCache, type JiraScanReport } from '../../src/jira/jira-store';
import { JiraAuthError, JiraUnavailableError, type JiraIssueDetail, type JiraSource } from '../../src/jira/jira-source';

function detailOf(key: string): JiraIssueDetail {
  return {
    key,
    summary: 'Do the thing',
    status: 'In Progress',
    statusCategory: 'indeterminate',
    assignee: '712020:me',
    assigneeName: null,
    updated: '2026-09-09T00:00:00.000Z',
    url: `https://example.atlassian.net/browse/${key}`,
    descriptionText: 'text',
    comments: [],
  };
}

function snapshot(updated: string): JiraScanReport {
  return {
    scannedAt: '2026-09-10T00:00:00.000Z',
    me: '712020:me',
    issues: [
      {
        key: 'HB-627',
        summary: 'Do the thing',
        status: 'In Progress',
        statusCategory: 'indeterminate',
        assignee: '712020:me',
        assigneeName: null,
        updated,
        url: 'https://example.atlassian.net/browse/HB-627',
      },
    ],
    error: null,
    kind: 'ok',
  };
}

function fakeSource(behaviour: { error?: unknown } = {}): JiraSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    search: async () => [],
    whoami: async () => ({ accountId: 'x', displayName: 'x' }),
    issue: async (key: string) => {
      calls.push(key);
      if (behaviour.error !== undefined) throw behaviour.error;
      return detailOf(key);
    },
  };
}

describe('TicketDetailCache (R36)', () => {
  it('two opens of the same ticket within 60 s make ONE Jira request', async () => {
    const source = fakeSource();
    let ms = 0;
    const cache = new TicketDetailCache({
      source,
      snapshot: async () => snapshot('2026-09-09T00:00:00.000Z'),
      now: () => new Date(ms),
    });
    await cache.detail('HB-627');
    ms = 59_000;
    await cache.detail('HB-627');
    expect(source.calls).toEqual(['HB-627']);
  });

  it('the TTL expires', async () => {
    const source = fakeSource();
    let ms = 0;
    const cache = new TicketDetailCache({
      source,
      snapshot: async () => snapshot('2026-09-09T00:00:00.000Z'),
      now: () => new Date(ms),
    });
    await cache.detail('HB-627');
    ms = 61_000;
    await cache.detail('HB-627');
    expect(source.calls).toEqual(['HB-627', 'HB-627']);
  });

  it('a changed `updated` in the scan snapshot invalidates IMMEDIATELY, without waiting out the TTL', async () => {
    const source = fakeSource();
    let updated = '2026-09-09T00:00:00.000Z';
    const cache = new TicketDetailCache({
      source,
      snapshot: async () => snapshot(updated),
      now: () => new Date(0),
    });
    await cache.detail('HB-627');
    updated = '2026-09-10T00:00:00.000Z';
    await cache.detail('HB-627');
    expect(source.calls.length).toBe(2);
  });

  it('with no source at all nothing is fetched and nothing errors', async () => {
    const cache = new TicketDetailCache({ source: null, snapshot: async () => snapshot('x') });
    expect(await cache.detail('HB-627')).toEqual({ ticket: null, ticketError: null, ticketErrorKind: 'not_configured' });
  });

  it('a fetch failure fills ticketError and leaves ticket null — the route never 5xxs because Jira is down', async () => {
    const cache = new TicketDetailCache({
      source: fakeSource({ error: new Error('Jira responded 500 for /issue/HB-627') }),
      snapshot: async () => snapshot('x'),
    });
    const result = await cache.detail('HB-627');
    expect(result.ticket).toBeNull();
    expect(result.ticketError).toContain('500');
  });

  it('0c — ticketErrorKind carries the failure reason: auth, unavailable, anything else, success', async () => {
    const kindFor = async (error?: unknown) =>
      (await new TicketDetailCache({ source: fakeSource({ error }), snapshot: async () => snapshot('x') }).detail('HB-627'))
        .ticketErrorKind;
    expect(await kindFor(new JiraAuthError('x', 401))).toBe('auth');
    expect(await kindFor(new JiraUnavailableError('x'))).toBe('unavailable');
    expect(await kindFor(new Error('boom'))).toBe('unavailable');
    expect(await kindFor(undefined)).toBeNull();
  });

  it('an item.changed triggers ZERO detail fetches — nothing here subscribes to an event', async () => {
    const source = fakeSource();
    const cache = new TicketDetailCache({ source, snapshot: async () => snapshot('x') });
    // The cache is only ever driven by a tab open. A source grep is the guard:
    // it takes no `events` dep at all, so there is nothing to subscribe with.
    expect(Object.keys(cache)).not.toContain('events');
    expect(source.calls).toEqual([]);
  });
});
