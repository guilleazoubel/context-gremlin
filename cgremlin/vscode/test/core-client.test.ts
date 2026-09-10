import { describe, expect, it, afterEach } from 'vitest';
import { CoreClient, CoreHttpError, EngineNotRunningError } from '../src/core-client';
import { fixtures, startStubServer, type StubHandler, type StubServerHandle } from './support/stub-server';

const servers: StubServerHandle[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.dispose();
});

async function client(handler?: StubHandler): Promise<{
  core: CoreClient;
  server: StubServerHandle;
}> {
  const server = await startStubServer({ handler });
  servers.push(server);
  return { core: new CoreClient(server.socketPath), server };
}

describe('CoreClient — the engine is not running', () => {
  it('rejects with EngineNotRunningError for a socket that does not exist', async () => {
    const core = new CoreClient('/tmp/cgremlin-does-not-exist-9f1c.sock');
    await expect(core.request('GET', '/config')).rejects.toBeInstanceOf(EngineNotRunningError);
  });

  it('reports a typed method the same way', async () => {
    const core = new CoreClient('/tmp/cgremlin-does-not-exist-9f1c.sock');
    const err = await core.sessions().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineNotRunningError);
  });
});

describe('CoreClient — reads', () => {
  it('unwraps GET /config', async () => {
    const { core, server } = await client();
    const config = await core.config();
    expect(config.me).toBe('guille');
    expect(config.sessionsDir).toBe('/tmp/cgremlin-fixture/sessions');
    expect(server.requests[0]).toMatchObject({ method: 'GET', path: '/config' });
  });

  it('returns GET /prs inventory and groups', async () => {
    const { core } = await client();
    const { inventory, groups } = await core.prs();
    expect(inventory.entries).toHaveLength(5);
    expect(groups.unreviewed.map((e) => e.number)).toEqual([101]);
  });

  it('returns GET /sessions', async () => {
    const { core } = await client();
    const { sessions } = await core.sessions();
    expect(sessions.map((s) => s.id)).toContain('pr-offcfg-lab-55');
  });

  it('asks for every attention item when told to', async () => {
    const { core, server } = await client();
    const bare = await core.attention();
    expect(bare.items.length).toBeGreaterThan(0);
    expect(server.requests[0]?.url).toBe('/attention');
    await core.attention(true);
    expect(server.requests[1]?.query.get('all')).toBe('1');
  });

  it('returns the artifact listing and the core-chosen primary', async () => {
    const { core, server } = await client();
    const listing = await core.artifacts('pr-acme-web-102');
    expect(listing.primary).toBe('REVIEW.md');
    expect(listing.artifacts.map((a) => a.name)).toEqual(['BRIEF.md', 'REVIEW.md']);
    expect(server.requests[0]?.path).toBe('/sessions/pr-acme-web-102/artifacts');
  });

  it('returns the conversation view', async () => {
    const { core, server } = await client();
    const view = await core.conversation('pr-acme-web-102');
    expect(view).toMatchObject({ runner: 'claude-code', claimed: false });
    expect(server.requests[0]?.path).toBe('/sessions/pr-acme-web-102/conversation');
  });

  it('passes a session id containing a colon through verbatim', async () => {
    const { core, server } = await client();
    await core.artifacts('inv:weird:id');
    expect(server.requests[0]?.path).toBe('/sessions/inv:weird:id/artifacts');
  });

  it('throws CoreHttpError when a read fails', async () => {
    const { core } = await client(() => ({ status: 500, body: { error: 'inventory not configured' } }));
    const err = await core.prs().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoreHttpError);
    expect((err as CoreHttpError).status).toBe(500);
    expect((err as CoreHttpError).message).toContain('inventory not configured');
  });
});

describe('CoreClient — writes', () => {
  it('claims and releases a conversation', async () => {
    const { core, server } = await client();
    await core.claim('pr-acme-web-102');
    await core.release('pr-acme-web-102');
    expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /sessions/pr-acme-web-102/conversation/claim',
      'POST /sessions/pr-acme-web-102/conversation/release',
    ]);
  });

  it('surfaces a 409 on claim as an error carrying the engine wording', async () => {
    const { core } = await client(() => ({ status: 409, body: { error: 'a run is in progress' } }));
    const err = await core.claim('pr-acme-web-102').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoreHttpError);
    expect((err as CoreHttpError).status).toBe(409);
  });

  it('addresses the review, stage and lifecycle routes', async () => {
    const { core, server } = await client();
    await core.startReview('acme/web', 101);
    await core.approvePlan('inv-acme-web-7f3');
    await core.stop('dev-acme-api-7');
    await core.retry('dev-acme-api-7');
    await core.run('dev-acme-api-7', 'develop');
    await core.scan();
    expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /prs/acme/web/101/review',
      'POST /sessions/inv-acme-web-7f3/approve-plan',
      'POST /sessions/dev-acme-api-7/stop',
      'POST /sessions/dev-acme-api-7/retry',
      'POST /sessions/dev-acme-api-7/run',
      'POST /prs/scan',
    ]);
    expect(server.requests[4]?.body).toEqual({ stage: 'develop' });
  });

  it('acks through the generic path and the two aliases', async () => {
    const { core, server } = await client();
    await core.ack('session:pr-acme-web-102');
    await core.ackSession('pr-acme-web-102');
    await core.ackPr('acme/web', 103);
    expect(server.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /attention/ack',
      'POST /sessions/pr-acme-web-102/ack',
      'POST /prs/acme/web/103/ack',
    ]);
    expect(server.requests[0]?.body).toEqual({ ref: 'session:pr-acme-web-102' });
  });

  it('creates investigations, development sessions and reviews from a URL', async () => {
    const { core, server } = await client();
    const inv = await core.createInvestigation({
      repoUrl: 'https://github.com/acme/web.git',
      ticket: 'ING-412',
      intent: 'development',
      driveToCompletion: false,
    });
    const dev = await core.createDevelopment({ repoUrl: 'https://github.com/acme/web.git', ticket: 'ING-413' });
    const review = await core.createReviewFromUrl('https://github.com/other/repo/pull/12');
    expect([inv.status, dev.status, review.status]).toEqual([201, 201, 202]);
    expect(server.requests.map((r) => r.path)).toEqual([
      '/sessions/investigations',
      '/sessions/developments',
      '/reviews',
    ]);
    expect(server.requests[1]?.body).toEqual({
      repoUrl: 'https://github.com/acme/web.git',
      ticket: 'ING-413',
    });
    expect(server.requests[2]?.body).toEqual({ prUrl: 'https://github.com/other/repo/pull/12' });
  });

  it('resolves rather than throws for a 409 on an HttpResult method', async () => {
    const { core } = await client(() => ({ status: 409, body: { error: 'PR acme/web#103 is your own' } }));
    const result = await core.createReviewFromUrl('https://github.com/acme/web/pull/103');
    expect(result).toEqual({ status: 409, body: { error: 'PR acme/web#103 is your own' } });
  });

  it('resolves a 404 on request() with the engine body', async () => {
    const { core } = await client(() => ({ status: 404, body: { error: 'not found' } }));
    await expect(core.request('POST', '/nope')).resolves.toEqual({
      status: 404,
      body: { error: 'not found' },
    });
  });
});

describe('the committed fixtures', () => {
  it('carry the shapes the view model is built against', () => {
    const attention = fixtures.attention as { items: { ref: string }[] };
    expect(attention.items.length).toBe(10);
    expect(new Set(attention.items.map((i) => i.ref)).size).toBe(10);
  });
});
