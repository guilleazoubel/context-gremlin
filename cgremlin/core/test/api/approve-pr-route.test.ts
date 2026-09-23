import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiServer } from '../../src/api/server';
import { createHarness, SESSIONS_DIR, WORKTREES_DIR, type PipelineHarness } from '../support/pipeline-harness';
import { migrateV1ToV2, type ReviewSession, type SessionV1 } from '../../src/schema/session';
import type { PostTarget } from '../../src/workspace/post-helpers';

/**
 * The human's approve verb, and the reason it cannot be aimed anywhere else:
 * the route's only parameter is a session id, and the pull request comes out
 * of that session's own document (src/gh/pr-approval.ts).
 */
let dir: string;
let socketPath: string;
let server: http.Server;
let h: PipelineHarness;
let approved: PostTarget[];
let failure: Error | null;

function request(method: string, urlPath: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath,
        path: urlPath,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown;
          if (raw) {
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = raw;
            }
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function reviewSession(id: string, repo: string, number: number, stageStatus = 'ready'): ReviewSession {
  const v1: SessionV1 = {
    schemaVersion: 1, id, mode: 'review', createdAt: '2026-09-04T10:00:00.000Z',
    workspace: { repoUrl: `git@github.com:${repo}.git`, worktreePath: `${WORKTREES_DIR}/${id}` },
    lineage: { pipelineId: id, parentSessionId: null, ticket: null },
    stageStatus: 'ready',
  };
  const base = migrateV1ToV2(v1) as ReviewSession;
  return {
    ...base,
    stageStatus: stageStatus as ReviewSession['stageStatus'],
    pr: {
      repo, number, url: `https://github.com/${repo}/pull/${number}`,
      headSha: 'a'.repeat(40), reviewedSha: 'a'.repeat(40), title: 't', author: 'bob',
    },
  };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-approve-pr-'));
  socketPath = path.join(dir, 'api.sock');
  h = createHarness();
  approved = [];
  failure = null;
  server = createApiServer({
    sessionStore: h.store,
    workspaceManager: h.workspace,
    pipeline: h.service,
    fs: h.fs,
    sessionsDir: SESSIONS_DIR,
    events: h.events,
    lock: h.lock,
    prApprover: {
      approve: async (target: PostTarget) => {
        if (failure !== null) throw failure;
        approved.push(target);
      },
    },
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe('POST /sessions/:id/approve-pr — the human approves the session’s own PR', () => {
  it('approves exactly the pull request the session reviewed', async () => {
    await h.store.save(reviewSession('pr-app-42-a', 'acme/app', 42));
    const res = await request('POST', '/sessions/pr-app-42-a/approve-pr');
    expect(res.status).toBe(200);
    expect(approved).toEqual([{ repoSlug: 'acme/app', prNumber: 42 }]);
    expect((res.body as { session: ReviewSession }).session.stageStatus).toBe('approved');
  });

  it('refuses a body naming a different pull request, and approves nothing', async () => {
    await h.store.save(reviewSession('pr-app-42-a', 'acme/app', 42));
    const res = await request('POST', '/sessions/pr-app-42-a/approve-pr', { repo: 'acme/other', prNumber: 99 });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain('acme/app#42');
    expect(approved).toEqual([]);
  });

  it('refuses a session that is not a review', async () => {
    const inv = migrateV1ToV2({
      schemaVersion: 1, id: 'inv-1', mode: 'investigation', createdAt: '2026-09-04T10:00:00.000Z',
      workspace: { repoUrl: 'git@github.com:acme/app.git' },
      lineage: { pipelineId: 'inv-1', parentSessionId: null, ticket: null },
      stageStatus: 'findings',
    });
    await h.store.save(inv);
    const res = await request('POST', '/sessions/inv-1/approve-pr');
    expect(res.status).toBe(409);
    expect(approved).toEqual([]);
  });

  it('refuses a review that has not written its review yet', async () => {
    await h.store.save(reviewSession('pr-app-7-a', 'acme/app', 7, 'reviewing'));
    const res = await request('POST', '/sessions/pr-app-7-a/approve-pr');
    expect(res.status).toBe(409);
    expect(approved).toEqual([]);
  });

  it('404s for an unknown session', async () => {
    const res = await request('POST', '/sessions/pr-nope-1-a/approve-pr');
    expect(res.status).toBe(404);
    expect(approved).toEqual([]);
  });

  it('surfaces a GitHub refusal and leaves the session where it was', async () => {
    await h.store.save(reviewSession('pr-app-42-a', 'acme/app', 42));
    failure = Object.assign(new Error('GitHub refused the approval'), { name: 'PrApprovalFailedError' });
    const res = await request('POST', '/sessions/pr-app-42-a/approve-pr');
    expect(res.status).toBe(409);
    expect((await h.store.load('pr-app-42-a')).stageStatus).toBe('ready');
  });
});
