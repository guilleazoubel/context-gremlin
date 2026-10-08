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
import { ToolActivityLog } from './tool-activity';

// Re-exported so existing `import { UnknownAgentHandleError } from
// './claude-code-runner'` call sites keep working after the move to
// ./agent-runner-errors.ts (shared with CodexRunner).
export { UnknownAgentHandleError };

/**
 * R116 — the stage's route decides the effort, so a `CLAUDE_CODE_EFFORT_LEVEL` inherited from
 * whatever launched the engine (VS Code started from a shell that exported it) must not
 * override it. Removed on every spawn, routed or not; the engine's own env is never touched.
 */
export function claudeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.CLAUDE_CODE_EFFORT_LEVEL;
  return env;
}

interface ClaudeAgentState {
  ctx: SessionContext;
  outputCallbacks: Array<(chunk: AgentOutput) => void>;
  exitCallbacks: Array<(result: AgentExitResult) => void>;
  claudeSessionId?: string;
  currentProcess?: ChildProcessByStdio<null, Readable, Readable>;
  /** Defect 5 — turns this handle's tool calls into the work log a watcher reads. */
  activity: ToolActivityLog;
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
    this.handles.set(id, {
      ctx,
      outputCallbacks: [],
      exitCallbacks: [],
      claudeSessionId: ctx.resumeId,
      activity: new ToolActivityLog(),
    });
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
    const model = state.ctx.model ?? this.model;
    if (model) {
      args.push('--model', model);
    }
    if (state.ctx.effort) {
      args.push('--effort', state.ctx.effort);
    }
    if (state.claudeSessionId) {
      args.push('--resume', state.claudeSessionId);
    }

    return new Promise((resolve, reject) => {
      const child = spawn(this.claudeBinary, args, {
        cwd: state.ctx.workingDirectory,
        stdio: ['ignore', 'pipe', 'pipe'] as const,
        detached: true,
        env: claudeEnv(process.env),
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

  private emitStdout(state: ClaudeAgentState, data: string): void {
    for (const callback of state.outputCallbacks) {
      callback({ stream: 'stdout', data });
    }
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

    // Defect 5 — an agent's time is spent in TOOL calls, not in prose. Forwarding only
    // `type: 'text'` left a watcher with a near-empty pane (one frame in 45 seconds, measured
    // against a real run), which is indistinguishable from a broken button. `assistant` records
    // carry the calls, `user` records carry their results, and `tool-activity.ts` reduces each to
    // one short line — never the raw input, and never a whole result.
    if (
      (record.type === 'assistant' || record.type === 'user') &&
      record.message &&
      typeof record.message === 'object'
    ) {
      const message = record.message as Record<string, unknown>;
      const content = Array.isArray(message.content) ? message.content : [];
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        const kind = (part as Record<string, unknown>).type;
        if (kind === 'text' && record.type === 'assistant') {
          const text = (part as Record<string, unknown>).text;
          if (typeof text === 'string') this.emitStdout(state, text);
          continue;
        }
        const line =
          kind === 'tool_use'
            ? state.activity.noteToolUse(part)
            : kind === 'tool_result'
              ? state.activity.noteToolResult(part)
              : null;
        if (line !== null) this.emitStdout(state, line);
      }
    }

    if (record.type === 'result') {
      if (typeof record.session_id === 'string') state.claudeSessionId = record.session_id;
      // Defect 2 — the turn's own verdict. A failed turn puts the reason HERE
      // and, in the case that cost the user a run, nowhere else: nothing on
      // stderr, an exit code of 1, and a `result` event saying "Failed to
      // authenticate: OAuth session expired and could not be refreshed".
      // Harvesting only `session_id` threw that sentence away. Forwarded on
      // stderr because it is what went wrong, and only when it went wrong —
      // a successful turn's `result` text is the answer, already delivered
      // as assistant text above.
      if (record.is_error === true && typeof record.result === 'string' && record.result !== '') {
        for (const callback of state.outputCallbacks) {
          callback({ stream: 'stderr', data: record.result });
        }
      }
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

  /** `undefined` between `start()` and the child actually spawning, or once it has exited (currentProcess is cleared on 'close'/'error'). Never a claim that the handle is dead. */
  getPid(handle: AgentHandle): number | undefined {
    return this.requireState(handle).currentProcess?.pid;
  }

  private requireState(handle: AgentHandle): ClaudeAgentState {
    const state = this.handles.get(handle.id);
    if (!state) {
      throw new UnknownAgentHandleError(handle.id);
    }
    return state;
  }
}
