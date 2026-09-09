import { describe, expect, it } from 'vitest';
import { FakeLocalAppRunner } from './fake-local-app-runner';
import type { LocalAppSpec } from '../../src/env/local-app-runner';

const SPEC: LocalAppSpec = { cwd: '/repo', command: 'pnpm dev', logPath: '/repo/dev.log' };

describe('FakeLocalAppRunner', () => {
  it('returns queued exec responses in order and records them in execCalls', async () => {
    const runner = new FakeLocalAppRunner();
    runner.queueExec({ code: 0, stdout: 'first', stderr: '' });
    runner.queueExec({ code: 1, stdout: '', stderr: 'second' });
    const a = await runner.exec('a', { cwd: '/repo' });
    const b = await runner.exec('b', { cwd: '/repo' });
    expect(a).toEqual({ code: 0, stdout: 'first', stderr: '' });
    expect(b).toEqual({ code: 1, stdout: '', stderr: 'second' });
    expect(runner.execCalls).toEqual([
      { command: 'a', opts: { cwd: '/repo' } },
      { command: 'b', opts: { cwd: '/repo' } },
    ]);
  });

  it('unqueued exec defaults to a clean success', async () => {
    const runner = new FakeLocalAppRunner();
    await expect(runner.exec('x', { cwd: '/repo' })).resolves.toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('throws a queued Error from exec instead of returning it', async () => {
    const runner = new FakeLocalAppRunner();
    runner.queueExec(new Error('boom'));
    await expect(runner.exec('x', { cwd: '/repo' })).rejects.toThrow('boom');
  });

  it('returns queued healthcheck responses in order', async () => {
    const runner = new FakeLocalAppRunner();
    runner.queueHealth({ ok: false, status: null, reason: 'nope', exited: false });
    runner.queueHealth({ ok: true, status: 200, reason: null, exited: false });
    const a = await runner.healthcheck('http://x', { timeoutMs: 1, intervalMs: 1, insecureTls: false });
    const b = await runner.healthcheck('http://x', { timeoutMs: 1, intervalMs: 1, insecureTls: false });
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(true);
  });

  it('setPortListener makes portListenerPid return the given pid for any port', async () => {
    const runner = new FakeLocalAppRunner();
    runner.setPortListener(1234);
    expect(await runner.portListenerPid(80)).toBe(1234);
    expect(await runner.portListenerPid(9999)).toBe(1234);
    runner.setPortListener(null);
    expect(await runner.portListenerPid(80)).toBeNull();
  });

  it('start records the spec, returns the scripted process and sets the port listener to it', async () => {
    const runner = new FakeLocalAppRunner();
    runner.setStartResult({ pid: 42, pgid: 42, startedAt: 't' });
    const proc = await runner.start(SPEC);
    expect(proc).toEqual({ pid: 42, pgid: 42, startedAt: 't' });
    expect(runner.startCalls).toEqual([SPEC]);
    expect(await runner.portListenerPid(SPEC.cwd as unknown as number)).toBe(42);
  });

  it('stop records the call and clears the port listener', async () => {
    const runner = new FakeLocalAppRunner();
    const proc = await runner.start(SPEC);
    await runner.stop(proc, { port: 8080 });
    expect(runner.stopCalls).toEqual([{ proc, opts: { port: 8080 } }]);
    expect(await runner.portListenerPid(8080)).toBeNull();
  });

  it('isAlive reflects start/stop and setAlive', async () => {
    const runner = new FakeLocalAppRunner();
    expect(await runner.isAlive({ pid: 1, pgid: 1, startedAt: 't' })).toBe(false);
    const proc = await runner.start(SPEC);
    expect(await runner.isAlive(proc)).toBe(true);
    await runner.stop(proc, { port: 8080 });
    expect(await runner.isAlive(proc)).toBe(false);
    runner.setAlive(true);
    expect(await runner.isAlive(proc)).toBe(true);
  });

  it('pgidOf defaults to the pid unless overridden via setPgid', async () => {
    const runner = new FakeLocalAppRunner();
    expect(await runner.pgidOf(200)).toBe(200);
    runner.setPgid(200, 250);
    expect(await runner.pgidOf(200)).toBe(250);
  });

  it('appends local.start / local.stop to a shared call log in order', async () => {
    const callLog: string[] = [];
    const runner = new FakeLocalAppRunner({ callLog });
    const proc = await runner.start(SPEC);
    await runner.stop(proc, { port: 8080 });
    expect(callLog).toEqual(['local.start', 'local.stop']);
  });
});
