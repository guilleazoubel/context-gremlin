import { spawn } from 'node:child_process';
import { GhCommandError, type GhRunner } from './gh-runner';

export { GhCommandError };

export class NodeGhRunner implements GhRunner {
  constructor(private readonly binary = 'gh') {}

  run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (err) => {
        reject(new GhCommandError(args, null, err.message));
      });
      child.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new GhCommandError(args, code, stderr));
        }
      });
    });
  }
}
