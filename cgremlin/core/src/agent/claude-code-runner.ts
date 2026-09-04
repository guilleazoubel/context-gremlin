import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type {
  AgentExitResult,
  AgentHandle,
  AgentOutput,
  AgentRunner,
  SessionContext,
} from './agent-runner';

interface ClaudeAgentState {
  ctx: SessionContext;
  outputCallbacks: Array<(chunk: AgentOutput) => void>;
  exitCallbacks: Array<(result: AgentExitResult) => void>;
  claudeSessionId?: string;
  currentProcess?: ChildProcessByStdio<null, Readable, Readable>;
}

export class UnknownAgentHandleError extends Error {
  constructor(id: string) {
    super(`Unknown agent handle: '${id}'`);
    this.name = 'UnknownAgentHandleError';
  }
}

export interface ClaudeCodeRunnerOptions {
  readonly claudeBinary?: string;
  readonly permissionMode?: string;
  readonly model?: string;
}

export class ClaudeCodeRunner implements AgentRunner {
  private nextId = 1;
  private readonly handles = new Map<string, ClaudeAgentState>();
  private readonly claudeBinary: string;
  private readonly permissionMode: string;
  private readonly model: string | undefined;

  constructor(options: ClaudeCodeRunnerOptions = {}) {
    this.claudeBinary = options.claudeBinary ?? 'claude';
    this.permissionMode = options.permissionMode ?? 'bypassPermissions';
    this.model = options.model;
  }

  async start(ctx: SessionContext): Promise<AgentHandle> {
    const id = `claude-agent-${this.nextId++}`;
    this.handles.set(id, { ctx, outputCallbacks: [], exitCallbacks: [], claudeSessionId: ctx.resumeId });
    return { id };
  }

  /**
   * Do not call sendPrompt again on the same handle before the previous
   * call's promise resolves — overlapping calls are not supported and
   * may orphan the earlier process.
   */
  async sendPrompt(handle: AgentHandle, prompt: string): Promise<void> {
    const state = this.requireState(handle);
    const args = [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      this.permissionMode,
    ];
    for (const dir of state.ctx.additionalDirs ?? []) {
      args.push('--add-dir', dir);
    }
    if (this.model) {
      args.push('--model', this.model);
    }
    if (state.claudeSessionId) {
      args.push('--resume', state.claudeSessionId);
    }

    return new Promise((resolve, reject) => {
      const child = spawn(this.claudeBinary, args, {
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

  private handleLine(state: ClaudeAgentState, line: string): void {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      // Non-JSON output on stdout is unexpected with --output-format
      // stream-json; forward it raw rather than silently dropping it.
      for (const callback of state.outputCallbacks) {
        callback({ stream: 'stdout', data: line });
      }
      return;
    }
    if (!event || typeof event !== 'object') return;
    const record = event as Record<string, unknown>;

    if (record.type === 'assistant' && record.message && typeof record.message === 'object') {
      const message = record.message as Record<string, unknown>;
      const content = Array.isArray(message.content) ? message.content : [];
      for (const part of content) {
        if (
          part &&
          typeof part === 'object' &&
          (part as Record<string, unknown>).type === 'text'
        ) {
          const text = (part as Record<string, unknown>).text;
          if (typeof text === 'string') {
            for (const callback of state.outputCallbacks) {
              callback({ stream: 'stdout', data: text });
            }
          }
        }
      }
    }

    if (record.type === 'result' && typeof record.session_id === 'string') {
      state.claudeSessionId = record.session_id;
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

  getClaudeSessionId(handle: AgentHandle): string | undefined {
    return this.requireState(handle).claudeSessionId;
  }

  getResumeId(handle: AgentHandle): string | undefined {
    return this.getClaudeSessionId(handle);
  }

  private requireState(handle: AgentHandle): ClaudeAgentState {
    const state = this.handles.get(handle.id);
    if (!state) {
      throw new UnknownAgentHandleError(handle.id);
    }
    return state;
  }
}
