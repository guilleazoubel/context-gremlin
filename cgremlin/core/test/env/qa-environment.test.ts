import { describe, expect, it } from 'vitest';
import { EnvironmentService, type EnvironmentServiceDeps } from '../../src/env/environment-service';
import { resolveCoreConfig, type CoreConfig } from '../../src/config/core-config';
import { KeyedLock } from '../../src/api/keyed-lock';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { FakeGhRunner } from '../support/fake-gh-runner';
import { FakeGitRunner } from '../support/fake-git-runner';
import { FakeLocalAppRunner } from '../support/fake-local-app-runner';
import { SessionSchema, type Session } from '../../src/schema/session';

const HOME = '/home/u';
const SESSIONS_DIR = `${HOME}/.cgremlin-core/sessions`;
const REPO_URL = 'https://github.com/acme/app.git';
const SLUG = 'acme/app';
const SECRET = 'S3CRET-VALUE';

function makeConfig(env: Record<string, unknown>): CoreConfig {
  return resolveCoreConfig({ repos: [SLUG], me: 'me', environments: { [SLUG]: env } }, HOME);
}

function qaSession(): Session {
  return SessionSchema.parse({
    schemaVersion: 2,
    id: 'qa-1',
    mode: 'qa',
    createdAt: '2026-09-15T10:00:00.000Z',
    workspace: { repoUrl: REPO_URL, worktreePath: '/wt/qa-1', branch: 'qa/HB-1' },
    lineage: { pipelineId: 'qa-1', parentSessionId: null, ticket: 'HB-1' },
    agent: null,
    lastRun: null,
    pr: null,
    stageStatus: 'queued',
  });
}

function make(config: CoreConfig, local = new FakeLocalAppRunner()) {
  const fs = new InMemoryFileSystem();
  const deps: EnvironmentServiceDeps = {
    fs,
    gh: new FakeGhRunner(),
    git: new FakeGitRunner(),
    local,
    config,
    sessionsDir: SESSIONS_DIR,
    statePath: `${HOME}/.cgremlin-core/local-app.json`,
    lock: new KeyedLock(),
  };
  return { fs, local, service: new EnvironmentService(deps) };
}

describe('EnvironmentService.qaHealth', () => {
  it('is ok when the health path answers 2xx', async () => {
    const { service, local } = make(makeConfig({ qa: { url: 'https://qa.example.com', healthPath: '/health' } }));
    local.queueHealth({ ok: true, status: 200, reason: null, exited: false });
    expect(await service.qaHealth(REPO_URL)).toEqual({ ok: true, reason: null });
  });

  it('degrades, never throws, when the health check fails', async () => {
    const { service, local } = make(makeConfig({ qa: { url: 'https://qa.example.com' } }));
    local.queueHealth({ ok: false, status: null, reason: 'connect ECONNREFUSED', exited: false });
    expect(await service.qaHealth(REPO_URL)).toEqual({ ok: false, reason: 'connect ECONNREFUSED' });
  });

  it('degrades when the health check itself throws', async () => {
    const { service, local } = make(makeConfig({ qa: { url: 'https://qa.example.com' } }));
    local.queueHealth(new Error('boom'));
    const health = await service.qaHealth(REPO_URL);
    expect(health.ok).toBe(false);
    expect(health.reason).toContain('boom');
  });

  it('reports "not configured" without any network call when the repo has no QA url', async () => {
    const { service, local } = make(makeConfig({}));
    expect(await service.qaHealth(REPO_URL)).toEqual({ ok: false, reason: 'no QA environment is configured for acme/app' });
    expect(local.healthCallCount).toBe(0);
  });
});

describe('EnvironmentService.hasQaTestIdentity', () => {
  it("is false when auth is 'none' — the automatic leg must never run without an account", () => {
    const { service } = make(makeConfig({ qa: { url: 'https://q', auth: 'none' } }));
    expect(service.hasQaTestIdentity(REPO_URL)).toBe(false);
  });

  it('is false when the auth mode is set but its material is missing', () => {
    expect(make(makeConfig({ qa: { url: 'https://q', auth: 'clerk-test' } })).service.hasQaTestIdentity(REPO_URL)).toBe(false);
    expect(make(makeConfig({ qa: { url: 'https://q', auth: 'vercel-bypass' } })).service.hasQaTestIdentity(REPO_URL)).toBe(false);
  });

  it('is true once the material exists', () => {
    expect(
      make(makeConfig({ qa: { url: 'https://q', auth: 'clerk-test' }, clerk: {} })).service.hasQaTestIdentity(REPO_URL),
    ).toBe(true);
    expect(
      make(
        makeConfig({
          qa: { url: 'https://q', auth: 'vercel-bypass' },
          vercel: { scope: 's', project: 'p', previewProject: 'p', bypassSecret: SECRET },
        }),
      ).service.hasQaTestIdentity(REPO_URL),
    ).toBe(true);
  });

  it('is false when the repo has no QA environment at all', () => {
    expect(make(makeConfig({})).service.hasQaTestIdentity(REPO_URL)).toBe(false);
  });
});

describe('EnvironmentService.qaBriefContext', () => {
  it('is EMPTY_QA_ENVIRONMENT when the repo has no QA url', async () => {
    const { service } = make(makeConfig({}));
    expect(await service.qaBriefContext(qaSession())).toMatchObject({ url: null, auth: 'none' });
  });

  it('carries the resolved api base url, the flags and the posthog project', async () => {
    const { service, local } = make(
      makeConfig({
        qa: {
          url: 'https://qa.example.com',
          posthog: { project: 'grace', host: 'https://us.posthog.com' },
          featureFlags: ['hb-1'],
        },
      }),
    );
    local.queueHealth({ ok: true, status: 200, reason: null, exited: false });
    const ctx = await service.qaBriefContext(qaSession());
    expect(ctx).toMatchObject({
      url: 'https://qa.example.com',
      apiBaseUrl: 'https://qa.example.com',
      featureFlags: ['hb-1'],
      posthog: { project: 'grace', host: 'https://us.posthog.com' },
      unreachableReason: null,
    });
  });

  it('carries the bypass-secret PATH, never the secret', async () => {
    const { service, local } = make(
      makeConfig({
        qa: { url: 'https://qa.example.com', auth: 'vercel-bypass' },
        vercel: { scope: 's', project: 'p', previewProject: 'p', bypassSecret: SECRET },
      }),
    );
    local.queueHealth({ ok: true, status: 200, reason: null, exited: false });
    const ctx = await service.qaBriefContext(qaSession());
    expect(ctx.bypassSecretPath).toBe(`${SESSIONS_DIR}/qa-1/.bypass-secret`);
    expect(JSON.stringify(ctx)).not.toContain(SECRET);
  });

  it('carries the clerk test identity, with {key} resolved to THIS session so runs cannot collide', async () => {
    const { service, local } = make(makeConfig({ qa: { url: 'https://q', auth: 'clerk-test' }, clerk: {} }));
    local.queueHealth({ ok: true, status: 200, reason: null, exited: false });
    const ctx = await service.qaBriefContext(qaSession());
    expect(ctx.clerk).toEqual({
      emailTemplate: 'uicheck-qa-1+clerk_test@example.com',
      verificationCode: '424242',
    });
  });

  it('the exact config the user ships parses and yields a usable test identity', async () => {
    const config = resolveCoreConfig(
      {
        repos: [SLUG],
        me: 'me',
        environments: {
          [SLUG]: {
            qa: { url: 'https://findcare.qa.aplaceformom.com/', auth: 'clerk-test' },
            clerk: { testEmailTemplate: 'uicheck-{key}+clerk_test@example.com', verificationCode: '424242' },
          },
        },
      },
      HOME,
    );
    const { service, local } = make(config);
    expect(service.hasQaTestIdentity(REPO_URL)).toBe(true);
    local.queueHealth({ ok: true, status: 200, reason: null, exited: false });
    const ctx = await service.qaBriefContext(qaSession());
    expect(ctx.url).toBe('https://findcare.qa.aplaceformom.com/');
    expect(ctx.apiBaseUrl).toBe('https://findcare.qa.aplaceformom.com/');
    expect(ctx.clerk?.emailTemplate).toBe('uicheck-qa-1+clerk_test@example.com');
  });

  it('records an unreachable QA as a reason instead of throwing', async () => {
    const { service, local } = make(makeConfig({ qa: { url: 'https://q' } }));
    local.queueHealth({ ok: false, status: null, reason: 'timeout after 15000ms', exited: false });
    expect((await service.qaBriefContext(qaSession())).unreachableReason).toBe('timeout after 15000ms');
  });
});
