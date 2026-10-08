import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiServer } from '../../src/api/server';
import { createHarness, SESSIONS_DIR, WORKTREES_DIR, type PipelineHarness } from '../support/pipeline-harness';
import { FeedbackLog } from '../../src/feedback/feedback-log';
import { REVIEW_CONTRACT_EXAMPLE } from '../../src/pipeline/prompts';
import type { Session } from '../../src/schema/session';

let dir: string;
let socketPath: string;
let server: http.Server;
let h: PipelineHarness;

function request(method: string, urlPath: string, body?: unknown): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath, path: urlPath, method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : undefined,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function review(id: string): Session {
  return {
    schemaVersion: 2, id, mode: 'review', createdAt: '2026-10-08T10:00:00.000Z',
    workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath: `${WORKTREES_DIR}/${id}`, branch: 'pr-1' },
    lineage: { pipelineId: id, parentSessionId: null, ticket: null, selfReview: false },
    stageStatus: 'ready', agent: null, lastRun: null,
    pr: { repo: 'acme/app', number: 42, url: 'https://github.com/acme/app/pull/42', headSha: 'a'.repeat(40), reviewedSha: 'a'.repeat(40), title: 't', author: 'bob' },
    reviewVersion: 0, lastRereviewSummary: null,
  };
}

async function withReview(id: string): Promise<void> {
  await h.store.save(review(id));
  await h.fs.mkdir(`${SESSIONS_DIR}/${id}`, { recursive: true });
  await h.fs.writeFile(`${SESSIONS_DIR}/${id}/REVIEW.md`, REVIEW_CONTRACT_EXAMPLE);
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-feedback-routes-'));
  socketPath = path.join(dir, 'api.sock');
  h = createHarness({ feedback: (fs) => new FeedbackLog(fs, '/state/feedback.jsonl') });
  server = createApiServer({
    sessionStore: h.store,
    workspaceManager: h.workspace,
    pipeline: h.service,
    fs: h.fs,
    sessionsDir: SESSIONS_DIR,
    events: h.events,
    lock: h.lock,
    prApprover: { approve: async () => undefined },
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

describe('§20 — the routes a person calls are the human transitions', () => {
  it('POST /approve-pr over a 🔄 Request changes review records a rejected verdict', async () => {
    await withReview('rev-1');
    expect((await request('POST', '/sessions/rev-1/approve-pr')).status).toBe(200);
    expect((await h.feedback!.list()).map((r) => r.id)).toEqual(['verdict_rejected:rev-1:REVIEW.md']);
  });

  it('POST /transition to dismissed records review_dismissed', async () => {
    await withReview('rev-2');
    expect((await request('POST', '/sessions/rev-2/transition', { to: 'dismissed' })).status).toBe(200);
    expect((await h.feedback!.list()).map((r) => r.id)).toEqual(['review_dismissed:rev-2']);
  });

  it('a feedback append that fails never fails the approval or the transition (regression pin)', async () => {
    h.feedback!.appendOnce = async () => {
      throw new Error('disk full');
    };
    await withReview('rev-3');
    await withReview('rev-4');
    expect((await request('POST', '/sessions/rev-3/approve-pr')).status).toBe(200);
    expect((await request('POST', '/sessions/rev-4/transition', { to: 'dismissed' })).status).toBe(200);
    expect((await h.store.load('rev-3')).stageStatus).toBe('approved');
    expect((await h.store.load('rev-4')).stageStatus).toBe('dismissed');
    expect(await h.feedback!.list()).toEqual([]);
  });
});
