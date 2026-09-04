import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type {
  AgentExitResult,
  AgentHandle,
  AgentOutput,
  AgentRunner,
  SessionContext,
} from './agent-runner';
import { UnknownAgentHandleError } from './agent-runner-errors';

// Re-exported so codex-runner.test.ts (and any future caller) can import it
// from the same module as CodexRunner, mirroring claude-code-runner.ts.
export { UnknownAgentHandleError };

interface CodexAgentState {
  ctx: SessionContext;
  outputCallbacks: Array<(chunk: AgentOutput) => void>;
  exitCallbacks: Array<(result: AgentExitResult) => void>;
  threadId?: string;
  currentProcess?: ChildProcessByStdio<null, Readable, Readable>;
}

export interface CodexRunnerOptions {
  readonly codexBinary?: string;
  readonly sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  readonly model?: string;
  readonly skipGitRepoCheck?: boolean;
  readonly dangerouslyBypassApprovalsAndSandbox?: boolean;
}

export class CodexRunner implements AgentRunner {
  private nextId = 1;
  private readonly handles = new Map<string, CodexAgentState>();
  private readonly codexBinary: string;
  private readonly sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  private readonly model: string | undefined;
  private readonly skipGitRepoCheck: boolean;
  private readonly dangerouslyBypassApprovalsAndSandbox: boolean;

  constructor(options: CodexRunnerOptions = {}) {
    this.codexBinary = options.codexBinary ?? 'codex';
    this.sandbox = options.sandbox ?? 'workspace-write';
    this.model = options.model;
    this.skipGitRepoCheck = options.skipGitRepoCheck ?? false;
    this.dangerouslyBypassApprovalsAndSandbox = options.dangerouslyBypassApprovalsAndSandbox ?? false;
  }

  async start(ctx: SessionContext): Promise<AgentHandle> {
    const id = `codex-agent-${this.nextId++}`;
    this.handles.set(id, { ctx, outputCallbacks: [], exitCallbacks: [], threadId: ctx.resumeId });
    return { id };
  }

  /**
   * Do not call sendPrompt again on the same handle before the previous
   * call's promise resolves — overlapping calls are not supported and
   * may orphan the earlier process.
   */
  async sendPrompt(handle: AgentHandle, prompt: string): Promise<void> {
    const state = this.requireState(handle);
    const args = this.buildArgs(state, prompt);

    return new Promise((resolve, reject) => {
      const child = spawn(this.codexBinary, args, {
        cwd: state.ctx.workingDirectory,
        stdio: ['ignore', 'pipe', 'pipe'] as const,
      });
      state.currentProcess = child;

      let buffer = '';
      child.stdout.on('data', (data: Buffer) => {
        buffer += data.toString('utf8');
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (line.trim()) {
            this.handleLine(state, line);
          }
        }
      });

      child.stderr.on('data', (data: Buffer) => {
        for (const callback of state.outputCallbacks) {
          callback({ stream: 'stderr', data: data.toString('utf8') });
        }
      });

      child.on('error', (err) => {
        if (state.currentProcess === child) {
          state.currentProcess = undefined;
        }
        reject(err);
      });

      child.on('close', (code, signal) => {
        if (buffer.trim()) {
          this.handleLine(state, buffer);
          buffer = '';
        }
        if (state.currentProcess === child) {
          state.currentProcess = undefined;
        }
        for (const callback of state.exitCallbacks) {
          callback({ code, signal });
        }
        resolve();
      });
    });
  }

  private buildArgs(state: CodexAgentState, prompt: string): string[] {
    const args: string[] = ['exec'];
    if (state.threadId) {
      // Resumed turn: `-s/--sandbox` and `--add-dir` are rejected by `codex
      // exec resume` (the first turn already established them for the
      // thread), so they are deliberately omitted here.
      args.push('resume', state.threadId, '--json');
    } else {
      args.push('--json', '-s', this.sandbox);
    }
    if (this.model) {
      args.push('-m', this.model);
    }
    if (this.skipGitRepoCheck) {
      args.push('--skip-git-repo-check');
    }
    if (this.dangerouslyBypassApprovalsAndSandbox) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }
    if (!state.threadId) {
      for (const dir of state.ctx.additionalDirs ?? []) {
        args.push('--add-dir', dir);
      }
    }
    args.push(prompt);
    return args;
  }

  private handleLine(state: CodexAgentState, line: string): void {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      // Non-JSON output on stdout is unexpected with --json; forward it raw
      // rather than silently dropping it (same policy as ClaudeCodeRunner).
      for (const callback of state.outputCallbacks) {
        callback({ stream: 'stdout', data: line });
      }
      return;
    }
    if (!event || typeof event !== 'object') return;
    const record = event as Record<string, unknown>;

    switch (record.type) {
      case 'thread.started': {
        if (typeof record.thread_id === 'string') {
          state.threadId = record.thread_id;
        }
        break;
      }
      case 'item.completed': {
        const item = record.item;
        if (!item || typeof item !== 'object') break;
        const itemRecord = item as Record<string, unknown>;
        if (itemRecord.type === 'agent_message' && typeof itemRecord.text === 'string') {
          for (const callback of state.outputCallbacks) {
            callback({ stream: 'stdout', data: itemRecord.text });
          }
        } else if (itemRecord.type === 'error' && typeof itemRecord.message === 'string') {
          for (const callback of state.outputCallbacks) {
            callback({ stream: 'stderr', data: itemRecord.message });
          }
        }
        break;
      }
      case 'error': {
        if (typeof record.message === 'string') {
          for (const callback of state.outputCallbacks) {
            callback({ stream: 'stderr', data: record.message });
          }
        }
        break;
      }
      case 'turn.failed': {
        const error = record.error;
        if (error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string') {
          for (const callback of state.outputCallbacks) {
            callback({ stream: 'stderr', data: (error as Record<string, unknown>).message as string });
          }
        }
        break;
      }
      // 'turn.started', 'turn.completed', and any other event type carry
      // nothing the AgentRunner contract needs (usage/turn bookkeeping is
      // not part of it) — ignored.
      default:
        break;
    }
  }

  onOutput(handle: AgentHandle, callback: (chunk: AgentOutput) => void): void {
    this.requireState(handle).outputCallbacks.push(callback);
  }

  onExit(handle: AgentHandle, callback: (result: AgentExitResult) => void): void {
    this.requireState(handle).exitCallbacks.push(callback);
  }

  async stop(handle: AgentHandle): Promise<void> {
    this.requireState(handle).currentProcess?.kill();
  }

  getCodexThreadId(handle: AgentHandle): string | undefined {
    return this.requireState(handle).threadId;
  }

  getResumeId(handle: AgentHandle): string | undefined {
    return this.getCodexThreadId(handle);
  }

  private requireState(handle: AgentHandle): CodexAgentState {
    const state = this.handles.get(handle.id);
    if (!state) {
      throw new UnknownAgentHandleError(handle.id);
    }
    return state;
  }
}
