import { describe, expect, it } from 'vitest';
import { FakeAgentRunner, UnknownAgentHandleError } from '../support/fake-agent-runner';
import type { SessionContext } from '../../src/agent/agent-runner';

function makeContext(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    sessionId: 'inv-test-1',
    workingDirectory: '/work/inv-test-1',
    ...overrides,
  };
}

describe('FakeAgentRunner', () => {
  it('start() returns a handle with a unique id per call', async () => {
    const runner = new FakeAgentRunner();
    const a = await runner.start(makeContext());
    const b = await runner.start(makeContext());
    expect(a.id).not.toBe(b.id);
  });

  it('sendPrompt() records the prompt for later inspection', async () => {
    const runner = new FakeAgentRunner();
    const handle = await runner.start(makeContext());
    await runner.sendPrompt(handle, 'investigate the bug');
    expect(runner.getPrompts(handle)).toEqual(['investigate the bug']);
  });

  it('records multiple prompts in order', async () => {
    const runner = new FakeAgentRunner();
    const handle = await runner.start(makeContext());
    await runner.sendPrompt(handle, 'first');
    await runner.sendPrompt(handle, 'second');
    expect(runner.getPrompts(handle)).toEqual(['first', 'second']);
  });

  it('onOutput() callback fires with the emitted chunk', async () => {
    const runner = new FakeAgentRunner();
    const handle = await runner.start(makeContext());
    const received: unknown[] = [];
    runner.onOutput(handle, (chunk) => received.push(chunk));
    runner.emitOutput(handle, { stream: 'stdout', data: 'hello' });
    expect(received).toEqual([{ stream: 'stdout', data: 'hello' }]);
  });

  it('supports multiple onOutput listeners, all of which fire', async () => {
    const runner = new FakeAgentRunner();
    const handle = await runner.start(makeContext());
    const a: unknown[] = [];
    const b: unknown[] = [];
    runner.onOutput(handle, (chunk) => a.push(chunk));
    runner.onOutput(handle, (chunk) => b.push(chunk));
    runner.emitOutput(handle, { stream: 'stderr', data: 'oops' });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('onExit() callback fires with the emitted result', async () => {
    const runner = new FakeAgentRunner();
    const handle = await runner.start(makeContext());
    const received: unknown[] = [];
    runner.onExit(handle, (result) => received.push(result));
    runner.emitExit(handle, { code: 0, signal: null });
    expect(received).toEqual([{ code: 0, signal: null }]);
  });

  it('stop() marks the handle as stopped', async () => {
    const runner = new FakeAgentRunner();
    const handle = await runner.start(makeContext());
    expect(runner.isStopped(handle)).toBe(false);
    await runner.stop(handle);
    expect(runner.isStopped(handle)).toBe(true);
  });

  it('two started handles have independent state', async () => {
    const runner = new FakeAgentRunner();
    const a = await runner.start(makeContext({ sessionId: 'inv-a' }));
    const b = await runner.start(makeContext({ sessionId: 'inv-b' }));
    await runner.sendPrompt(a, 'only for a');
    expect(runner.getPrompts(a)).toEqual(['only for a']);
    expect(runner.getPrompts(b)).toEqual([]);
    expect(runner.getContext(a).sessionId).toBe('inv-a');
    expect(runner.getContext(b).sessionId).toBe('inv-b');
  });

  it('throws UnknownAgentHandleError for a handle from another runner instance', async () => {
    const runnerA = new FakeAgentRunner();
    const runnerB = new FakeAgentRunner();
    const handle = await runnerA.start(makeContext());
    await expect(runnerB.sendPrompt(handle, 'x')).rejects.toThrow(UnknownAgentHandleError);
  });

  it('throws UnknownAgentHandleError for a fabricated or unknown handle', async () => {
    const runner = new FakeAgentRunner();
    await expect(runner.sendPrompt({ id: 'does-not-exist' }, 'x')).rejects.toThrow(
      UnknownAgentHandleError,
    );
  });

  it('exposes and allows seeding a resume id for tests', async () => {
    const runner = new FakeAgentRunner();
    const handle = await runner.start({ sessionId: 's', workingDirectory: '/w', resumeId: 'seed' });
    expect(runner.getResumeId(handle)).toBe('seed');
    runner.setResumeId(handle, 'next');
    expect(runner.getResumeId(handle)).toBe('next');
  });
});
