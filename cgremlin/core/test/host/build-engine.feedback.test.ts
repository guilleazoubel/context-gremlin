import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildEngine, type EngineAdapters } from '../../src/host/build-engine';
import { resolveCoreConfig, type CoreConfig } from '../../src/config/core-config';
import { REVIEW_CONTRACT_EXAMPLE } from '../../src/pipeline/prompts';
import type { Session } from '../../src/schema/session';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { FakeGitRunner } from '../support/fake-git-runner';
import { FakeGhRunner } from '../support/fake-gh-runner';
import { FakeAgentRunner } from '../support/fake-agent-runner';
import { FakeClock } from '../support/fake-clock';

const DISMISS_F2 = (text: string): string => text.replace(/(<a id="f2"><\/a>[\s\S]*?- \*\*Status:\*\*) open/, '$1 🔇 dismissed');

function config(): CoreConfig {
  return resolveCoreConfig(
    { repos: ['acme/app'], me: 'me-user', sessionsDir: '/sessions', worktreesDir: '/worktrees', mirrorsDir: '/mirrors' },
    '/home/e2e',
  );
}

function review(id: string): Session {
  return {
    schemaVersion: 2, id, mode: 'review', createdAt: '2026-10-08T10:00:00.000Z',
    workspace: { repoUrl: 'git@github.com:acme/app.git', worktreePath: `/worktrees/${id}`, branch: 'pr-1' },
    lineage: { pipelineId: id, parentSessionId: null, ticket: null, selfReview: false },
    stageStatus: 'ready', agent: null, lastRun: null,
    pr: { repo: 'acme/app', number: 7, url: 'https://github.com/acme/app/pull/7', headSha: 'a'.repeat(40), reviewedSha: 'a'.repeat(40), title: 't', author: 'bob' },
    reviewVersion: 0, lastRereviewSummary: null,
  };
}

function post(socketPath: string, urlPath: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { socketPath, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** Builds an engine on `cfg`, seeds two review sessions with a REVIEW.md, and has a person dismiss both through the API. */
async function dismissTwoThroughTheApi(cfg: CoreConfig): Promise<{ fs: InMemoryFileSystem; statuses: number[]; phases: string[] }> {
  const fs = new InMemoryFileSystem();
  const adapters: EngineAdapters = {
    fs, git: new FakeGitRunner(fs), gh: new FakeGhRunner(), runner: new FakeAgentRunner(), runnerKind: 'claude-code',
    clock: new FakeClock(), now: () => new Date('2026-10-08T12:00:00.000Z'),
  };
  const engine = buildEngine(cfg, adapters, { warn: () => undefined });
  for (const id of ['rev-1', 'rev-2']) {
    await engine.store.save(review(id));
    await fs.mkdir(`/sessions/${id}`, { recursive: true });
    await fs.writeFile(`/sessions/${id}/REVIEW.md`, DISMISS_F2(REVIEW_CONTRACT_EXAMPLE));
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'cgremlin-core-build-engine-feedback-'));
  const socketPath = path.join(dir, 'x.sock');
  await new Promise<void>((resolve) => engine.server.listen(socketPath, resolve));
  try {
    const statuses = await Promise.all(['rev-1', 'rev-2'].map((id) => post(socketPath, `/sessions/${id}/transition`, { to: 'dismissed' })));
    const phases = await Promise.all(['rev-1', 'rev-2'].map(async (id) => (await engine.store.load(id)).stageStatus));
    return { fs, statuses, phases };
  } finally {
    await new Promise<void>((resolve) => engine.server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildEngine wires feedback capture (§20, S2-19, S2-33)', () => {
  it('a person dismissing reviews through the built engine writes every record to config.feedbackPath', async () => {
    const cfg = config();
    expect(cfg.feedbackPath).toBe('/home/e2e/.cgremlin-core/feedback.jsonl');
    const { fs, statuses, phases } = await dismissTwoThroughTheApi(cfg);
    expect(statuses).toEqual([200, 200]);
    expect(phases).toEqual(['dismissed', 'dismissed']);
    const lines = (await fs.readFile(cfg.feedbackPath!)).trim().split('\n').map((l) => JSON.parse(l) as { kind: string; context: { sessionId: string } });
    expect(lines.map((r) => `${r.kind}:${r.context.sessionId}`).sort()).toEqual([
      'finding_dismissed:rev-1', 'finding_dismissed:rev-2', 'review_dismissed:rev-1', 'review_dismissed:rev-2',
    ]);
    expect(await fs.statMode(cfg.feedbackPath!)).toBe(0o600);
  });

  it('a hand-built config with no feedbackPath captures nothing, writes no file named "undefined", and still transitions (regression pin)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cfg = config();
    delete cfg.feedbackPath;
    const { fs, statuses, phases } = await dismissTwoThroughTheApi(cfg);
    expect(statuses).toEqual([200, 200]);
    expect(phases).toEqual(['dismissed', 'dismissed']);
    // Unguarded, a FeedbackLog on an undefined path fails every append (logged through console.warn).
    expect(warn.mock.calls.flat().filter((line) => String(line).includes('feedback capture'))).toEqual([]);
    expect(await fs.exists('undefined')).toBe(false);
    expect(await fs.exists('/home/e2e/.cgremlin-core/feedback.jsonl')).toBe(false);
  });
});
