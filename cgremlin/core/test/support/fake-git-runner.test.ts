import { describe, expect, it } from 'vitest';
import { FakeGitRunner } from './fake-git-runner';

describe('FakeGitRunner', () => {
  it('records the args and cwd of each call', async () => {
    const git = new FakeGitRunner();
    await git.run(['status'], { cwd: '/repo' });
    expect(git.calls).toEqual([{ args: ['status'], cwd: '/repo' }]);
  });

  it('returns queued responses in order', async () => {
    const git = new FakeGitRunner();
    git.queueResponse({ stdout: 'first', stderr: '' });
    git.queueResponse({ stdout: 'second', stderr: '' });
    const a = await git.run(['a'], { cwd: '/repo' });
    const b = await git.run(['b'], { cwd: '/repo' });
    expect(a.stdout).toBe('first');
    expect(b.stdout).toBe('second');
  });

  it('returns a default empty success response when no response is queued', async () => {
    const git = new FakeGitRunner();
    const result = await git.run(['status'], { cwd: '/repo' });
    expect(result).toEqual({ stdout: '', stderr: '' });
  });

  it('throws a queued Error instead of returning it', async () => {
    const git = new FakeGitRunner();
    git.queueResponse(new Error('git failed'));
    await expect(git.run(['bad'], { cwd: '/repo' })).rejects.toThrow('git failed');
  });
});
