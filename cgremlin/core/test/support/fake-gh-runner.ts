import type { GhRunner } from '../../src/gh/gh-runner';

export const GH_MUTATING_TOKENS = [
  'review', 'comment', 'merge', 'close', 'edit', 'create', 'ready', '--method', '-X', '-F', '-f',
  'reopen', 'lock', 'unlock', 'update-branch', 'delete', 'sync', '--input',
] as const;

const MUTATING_TOKEN_SET = new Set<string>(GH_MUTATING_TOKENS);

export class GhMutationAttemptedError extends Error {
  constructor(args: string[]) {
    super(`Refusing mutating gh invocation: gh ${args.join(' ')}`);
    this.name = 'GhMutationAttemptedError';
  }
}

export class FakeGhRunner implements GhRunner {
  readonly calls: string[][] = [];
  /**
   * Every invocation, INCLUDING the mutating ones refused below (which never reach `calls`). A
   * caller that swallows gh errors would otherwise hide a refused mutation from a read-only pin.
   */
  readonly attempts: string[][] = [];
  private responses: Array<{ stdout: string; stderr?: string } | Error> = [];

  queueResponse(r: { stdout: string; stderr?: string } | Error): void {
    this.responses.push(r);
  }

  async run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    this.attempts.push(args);
    if (args.some((arg) => MUTATING_TOKEN_SET.has(arg))) {
      throw new GhMutationAttemptedError(args);
    }
    this.calls.push(args);
    const next = this.responses.shift();
    if (next === undefined) {
      return { stdout: '', stderr: '' };
    }
    if (next instanceof Error) {
      throw next;
    }
    return { stdout: next.stdout, stderr: next.stderr ?? '' };
  }
}
