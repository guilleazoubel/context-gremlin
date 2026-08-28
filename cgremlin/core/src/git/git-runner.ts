export interface GitRunner {
  run(args: string[], options: { cwd: string }): Promise<{ stdout: string; stderr: string }>;
}
