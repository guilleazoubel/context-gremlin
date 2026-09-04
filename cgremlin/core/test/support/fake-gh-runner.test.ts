import { describe, expect, it } from 'vitest';
import { FakeGhRunner, GhMutationAttemptedError } from './fake-gh-runner';

describe('FakeGhRunner', () => {
  it('serves queued responses FIFO and records calls', async () => {
    const gh = new FakeGhRunner();
    gh.queueResponse({ stdout: '[]' });
    gh.queueResponse({ stdout: '{"number":1}' });
    expect((await gh.run(['pr', 'list', '--repo', 'a/b', '--json', 'number'])).stdout).toBe('[]');
    expect((await gh.run(['pr', 'view', '1'])).stdout).toBe('{"number":1}');
    expect(gh.calls).toEqual([['pr', 'list', '--repo', 'a/b', '--json', 'number'], ['pr', 'view', '1']]);
  });
  it('returns empty stdout when the queue is empty', async () => {
    expect((await new FakeGhRunner().run(['pr', 'list'])).stdout).toBe('');
  });
  it('rethrows a queued Error', async () => {
    const gh = new FakeGhRunner();
    gh.queueResponse(new Error('HTTP 404'));
    await expect(gh.run(['pr', 'view', '9'])).rejects.toThrow('HTTP 404');
  });
  it.each([
    ['pr', 'review', '1', '--approve'],
    ['pr', 'comment', '1', '--body', 'x'],
    ['pr', 'merge', '1'],
    ['pr', 'close', '1'],
    ['pr', 'edit', '1'],
    ['pr', 'create', '--draft'],
    ['pr', 'ready', '1'],
    ['api', 'repos/a/b/pulls/1/reviews', '--method', 'POST'],
    ['api', '-X', 'POST', 'x'],
    ['api', 'x', '-F', 'a=b'],
    ['api', 'x', '-f', 'a=b'],
  ])('refuses mutating argv %j before touching the queue', async (...args) => {
    const gh = new FakeGhRunner();
    gh.queueResponse({ stdout: 'should not be consumed' });
    await expect(gh.run(args)).rejects.toThrow(GhMutationAttemptedError);
    expect((await gh.run(['pr', 'list'])).stdout).toBe('should not be consumed');
  });
  it('does not confuse a read-only value containing a guarded word', async () => {
    const gh = new FakeGhRunner();
    gh.queueResponse({ stdout: 'ok' });
    // "reviewDecision" is a field name, not the `review` subcommand
    expect((await gh.run(['pr', 'list', '--json', 'number,reviewDecision'])).stdout).toBe('ok');
  });
});
