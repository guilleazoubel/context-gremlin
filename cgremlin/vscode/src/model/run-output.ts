/**
 * Defect 4 — the only place a live run's output is held, and the sentences that bound it.
 *
 * `run.output` is the ONE engine event with no authoritative re-read (see the R41 exception in
 * `ui/wiring.ts`): the output exists as it streams and nothing persists it, by construction. So
 * this buffer is not a cache of a thing that can be fetched again — it is the whole of what any
 * surface can honestly show, and it is discarded with the pane that showed it.
 *
 * Everything it exposes is therefore about its own limits: what it has, what it never had (a
 * beginning it joined too late for), what it dropped (a long run past the cap), and the point at
 * which it stopped. It never fabricates a beginning and it never claims to be the record — the
 * artifact the run wrote is the record.
 *
 * Pure module — no editor API, no DOM (MG-B1).
 */

/** Per session. A plan turn prints a few hundred lines; a screenful of scrollback past that is
 * navigation, not evidence, and the artifact is where evidence belongs. */
export const MAX_RUN_OUTPUT_LINES = 500;

export type RunOutputState = 'notStarted' | 'waiting' | 'streaming' | 'ended';

/**
 * Defect 5 — these five sentences were written for a stream of the agent's prose, and the pane
 * now carries a work log: each file read or edited, each command run, each capped answer. So each
 * one says WORK rather than printing — "has printed nothing yet" was the wrong question to ask
 * about an agent that is working hard and saying nothing.
 */
export const WAITING_NOTICE =
  'The run is live and has not done anything yet. Each file it reads or edits, and each command it runs, appears here as it happens.';
export const JOINED_MID_RUN_NOTICE =
  'You joined this run in progress. What it did before is not kept — this is only what it has done since the pane opened.';
export const NOT_STARTED_NOTICE =
  'Nothing is running for this session right now. What a run does appears here while a stage is running.';

/** `dropped > 0`: the cap bit, and the pane must not imply it is showing the whole run. */
export function droppedNotice(dropped: number): string {
  return `The first ${dropped} ${dropped === 1 ? 'line' : 'lines'} scrolled out of this view.`;
}

export function endedNotice(outcome: string | null): string {
  const how = outcome === null || outcome === '' ? 'The run ended' : `The run ended (${outcome})`;
  return `${how}. This is only the work it did while the pane was open, summarised; the artifact it wrote is the record.`;
}

export interface RunOutputView {
  sessionId: string;
  /** Oldest first, capped at {@link MAX_RUN_OUTPUT_LINES}. */
  lines: readonly string[];
  state: RunOutputState;
  /** The pane opened after the run had already started, so its beginning was never seen. */
  joinedMidRun: boolean;
  /** The one sentence above the lines, or `''` when the lines speak for themselves. */
  notice: string;
  /** The terminal line a finished run freezes on, `null` while it is still live. */
  ending: string | null;
  /** Which stage is printing, where the caller knew. Never guessed. */
  stage: string | null;
  /** How many lines fell out of the front of the buffer. */
  dropped: number;
}

export interface OpenOptions {
  /** The run was ALREADY running when this buffer was created — its start is unrecoverable. */
  alreadyRunning: boolean;
  stage: string | null;
  /** `false` opens a pane on a session with no run at all, which is a state and not an error. */
  live?: boolean;
}

interface Buffer {
  lines: string[];
  joinedMidRun: boolean;
  stage: string | null;
  dropped: number;
  ending: string | null;
  live: boolean;
}

/**
 * The buffers currently on screen — normally one, because the Item tab shows one agent at a time.
 * A session with no buffer is not watched: `append` for it is dropped rather than starting one,
 * so the global `run.output` subscription can never be kept alive by traffic alone.
 */
export class RunOutputStore {
  private readonly buffers = new Map<string, Buffer>();

  /** Idempotent: re-opening the pane on the session it is already showing keeps its scrollback. */
  open(sessionId: string, opts: OpenOptions): void {
    const existing = this.buffers.get(sessionId);
    if (existing !== undefined) return;
    this.buffers.set(sessionId, {
      lines: [],
      joinedMidRun: opts.alreadyRunning,
      stage: opts.stage,
      dropped: 0,
      ending: null,
      live: opts.live !== false,
    });
  }

  /**
   * One `run.output` chunk, already redacted by the engine (`event-stream.redactRunOutput`). A
   * chunk that arrives after the ending is refused: a frozen pane stays frozen, or the user
   * cannot tell the run they watched end from the next one.
   */
  append(sessionId: string, data: string): void {
    const buffer = this.buffers.get(sessionId);
    if (buffer === undefined || buffer.ending !== null) return;
    const lines = data.split('\n');
    // A chunk almost always ends in a newline; the empty tail it produces is not a line.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    if (lines.length === 0) return;
    buffer.lines.push(...lines);
    if (buffer.lines.length > MAX_RUN_OUTPUT_LINES) {
      const over = buffer.lines.length - MAX_RUN_OUTPUT_LINES;
      buffer.lines.splice(0, over);
      buffer.dropped += over;
    }
  }

  /** The run stopped while somebody was watching. The lines stay; nothing more may be added. */
  finish(sessionId: string, opts: { outcome: string | null }): void {
    const buffer = this.buffers.get(sessionId);
    if (buffer === undefined || buffer.ending !== null) return;
    buffer.ending = endedNotice(opts.outcome);
  }

  /** The pane closed. Nothing survives it — this buffer is not a record of anything. */
  close(sessionId: string): void {
    this.buffers.delete(sessionId);
  }

  closeAll(): void {
    this.buffers.clear();
  }

  /**
   * Whether the SSE client should be asking the engine for `run.output` frames at all.
   *
   * A FROZEN buffer does not count. The pane stays readable after its run ends — that is the
   * point of freezing rather than clearing it — but nothing more will ever arrive in it, and
   * keeping the high-volume include on for a pane that cannot change is the exact global cost
   * this negotiation exists to avoid.
   */
  watching(): boolean {
    for (const buffer of this.buffers.values()) {
      if (buffer.ending === null && buffer.live) return true;
    }
    return false;
  }

  viewOf(sessionId: string): RunOutputView | null {
    const buffer = this.buffers.get(sessionId);
    if (buffer === undefined) return null;
    return {
      sessionId,
      lines: [...buffer.lines],
      state: stateOf(buffer),
      joinedMidRun: buffer.joinedMidRun,
      notice: noticeOf(buffer),
      ending: buffer.ending,
      stage: buffer.stage,
      dropped: buffer.dropped,
    };
  }
}

function stateOf(buffer: Buffer): RunOutputState {
  if (buffer.ending !== null) return 'ended';
  if (!buffer.live) return 'notStarted';
  return buffer.lines.length === 0 ? 'waiting' : 'streaming';
}

/**
 * The ONE sentence above the lines, chosen by what the buffer cannot tell the user.
 *
 * A mid-run join outranks everything, because it is the standing caveat over every line below it.
 * A cap that bit is said next. A live run with nothing yet says so out loud — the defect that
 * forced this state is that an empty box and a wedged agent look identical. Otherwise: silence,
 * because the lines are the answer and a banner over them would be noise.
 */
function noticeOf(buffer: Buffer): string {
  if (buffer.joinedMidRun) return JOINED_MID_RUN_NOTICE;
  if (buffer.dropped > 0) return droppedNotice(buffer.dropped);
  if (!buffer.live) return NOT_STARTED_NOTICE;
  return buffer.lines.length === 0 && buffer.ending === null ? WAITING_NOTICE : '';
}
