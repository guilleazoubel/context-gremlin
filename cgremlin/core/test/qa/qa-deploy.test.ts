import { describe, expect, it } from 'vitest';
import { InMemoryFileSystem } from '../support/in-memory-file-system';
import { FakeGitRunner } from '../support/fake-git-runner';
import { DeployAncestry } from '../../src/qa/qa-deploy';

const MIRRORS = '/state/mirrors';
const SLUG = 'acme/app';
const MERGE = 'a'.repeat(40);
const DEPLOYED = '088ce5e07db734834e4948ad3365f4155cd1ae4e';

function gitError(code: number, stderr: string): Error {
  return Object.assign(new Error('git failed'), { code, stderr });
}

function make(): { git: FakeGitRunner; fs: InMemoryFileSystem; ancestry: DeployAncestry } {
  const git = new FakeGitRunner();
  const fs = new InMemoryFileSystem();
  return { git, fs, ancestry: new DeployAncestry({ git, fs, mirrorsDir: MIRRORS }) };
}

describe('DeployAncestry — is this merge commit IN the build QA is serving?', () => {
  it('exit 0 from merge-base --is-ancestor is "deployed"', async () => {
    const { git, ancestry } = make();
    expect(await ancestry.isAncestor(SLUG, MERGE, DEPLOYED)).toBe(true);
    expect(git.calls[0].args).toEqual(['merge-base', '--is-ancestor', MERGE, DEPLOYED]);
    expect(git.calls[0].cwd).toBe(`${MIRRORS}/github.com-acme-app.git`);
  });

  it('exit 1 is "not deployed", and costs exactly one git call — no fetch', async () => {
    const { git, ancestry } = make();
    git.queueResponse(gitError(1, ''));
    expect(await ancestry.isAncestor(SLUG, MERGE, DEPLOYED)).toBe(false);
    expect(git.calls.length).toBe(1);
  });

  it('a sha the mirror does not know is fetched ONCE, then answered', async () => {
    const { git, fs, ancestry } = make();
    await fs.mkdir(`${MIRRORS}/github.com-acme-app.git`, { recursive: true });
    await fs.writeFile(`${MIRRORS}/github.com-acme-app.git/HEAD`, 'ref: refs/heads/main\n');
    git.queueResponse(gitError(128, `fatal: Not a valid object name ${DEPLOYED}`));
    // ensureMirror's refspec reads, then its fetch, then the retried merge-base.
    git.queueResponse({ stdout: '+refs/heads/*:refs/remotes/origin/*\n+refs/pull/*/head:refs/remotes/origin/pr/*\n', stderr: '' });
    git.queueResponse({ stdout: '', stderr: '' });
    git.queueResponse({ stdout: '', stderr: '' });
    expect(await ancestry.isAncestor(SLUG, MERGE, DEPLOYED)).toBe(true);
    expect(git.calls.filter((c) => c.args[0] === 'fetch').length).toBe(1);
  });

  it('a sha still unknown after the fetch is NOT-YET-DEPLOYED, never an error', async () => {
    const { git, fs, ancestry } = make();
    await fs.mkdir(`${MIRRORS}/github.com-acme-app.git`, { recursive: true });
    await fs.writeFile(`${MIRRORS}/github.com-acme-app.git/HEAD`, 'ref: refs/heads/main\n');
    git.queueResponse(gitError(128, 'fatal: Not a valid object name'));
    git.queueResponse({ stdout: '+refs/heads/*:refs/remotes/origin/*\n+refs/pull/*/head:refs/remotes/origin/pr/*\n', stderr: '' });
    git.queueResponse({ stdout: '', stderr: '' });
    git.queueResponse(gitError(128, 'fatal: Not a valid object name'));
    expect(await ancestry.isAncestor(SLUG, MERGE, DEPLOYED)).toBe(false);
  });
});
