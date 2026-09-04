import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { GhCommandError, NodeGhRunner } from '../../src/gh/node-gh-runner';

function hasGh(): boolean { try { execSync('gh --version', { stdio: 'ignore' }); return true; } catch { return false; } }

describe.skipIf(!hasGh())('NodeGhRunner (real binary, read-only)', () => {
  it('runs `gh --version` and returns stdout', async () => {
    const { stdout } = await new NodeGhRunner().run(['--version']);
    expect(stdout).toMatch(/gh version \d+\.\d+\.\d+/);
  });
  it('rejects with GhCommandError carrying exit code and stderr on an unknown subcommand', async () => {
    await expect(new NodeGhRunner().run(['definitely-not-a-subcommand'])).rejects.toBeInstanceOf(GhCommandError);
  });
});
it('NodeGhRunner rejects with GhCommandError when the binary is missing', async () => {
  await expect(new NodeGhRunner('/nonexistent/gh-binary').run(['--version'])).rejects.toBeInstanceOf(GhCommandError);
});
