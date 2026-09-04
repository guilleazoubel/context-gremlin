export interface GhRunner {
  run(args: string[]): Promise<{ stdout: string; stderr: string }>;
}

export class GhCommandError extends Error {
  constructor(
    public readonly args: string[],
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(`gh ${args.join(' ')} exited with code ${exitCode}: ${stderr}`);
    this.name = 'GhCommandError';
  }
}
