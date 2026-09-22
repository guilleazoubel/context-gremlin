/**
 * Defect 4 — what a user may WATCH while a run they may not interrupt is live.
 *
 * `run.output` is the one engine event with no authoritative re-read: the output exists only as
 * it streams, and nothing persists it (the only listener was behind `serve()`'s `--verbose`). So
 * this buffer is the whole of what a pane can honestly show, and every sentence it prints is
 * about the limits of that: what it has, what it never had, and when it stopped.
 *
 * The live case that forced the `waiting` state: a plan stage eight minutes in, "i see it in
 * running status but i have no way to check what is really happening". An empty box and a broken
 * box look identical.
 */
import { describe, expect, it } from 'vitest';
import {
  INTERACTION_NOTE,
  JOINED_MID_RUN_NOTICE,
  MAX_RUN_OUTPUT_LINES,
  NOT_STARTED_NOTICE,
  RunOutputStore,
  WAITING_NOTICE,
  droppedNotice,
  endedNotice,
  type RunOutputView,
} from '../../src/model/run-output';

const SESSION = 'inv-aplaceformom-grace-frontend-HB-1492-20260922-135058';

function opened(alreadyRunning: boolean, stage: string | null = 'plan'): RunOutputStore {
  const store = new RunOutputStore();
  store.open(SESSION, { alreadyRunning, stage });
  return store;
}

const view = (store: RunOutputStore): RunOutputView => {
  const found = store.viewOf(SESSION);
  if (found === null) throw new Error('no buffer');
  return found;
};

describe('the buffer holds only what it saw', () => {
  it('keeps the last 500 lines and says how many it dropped, never that it has them all', () => {
    const store = opened(false);
    for (let i = 0; i < MAX_RUN_OUTPUT_LINES + 20; i += 1) store.append(SESSION, `line ${i}`);
    const shown = view(store);
    expect(shown.lines).toHaveLength(MAX_RUN_OUTPUT_LINES);
    expect(shown.lines[0]).toBe('line 20');
    expect(shown.dropped).toBe(20);
  });

  it('splits a multi-line chunk into lines and drops the trailing empty one', () => {
    const store = opened(false);
    store.append(SESSION, 'one\ntwo\n');
    expect(view(store).lines).toEqual(['one', 'two']);
  });

  it('is dropped on close — nothing survives the pane that showed it', () => {
    const store = opened(false);
    store.append(SESSION, 'something');
    store.close(SESSION);
    expect(store.viewOf(SESSION)).toBeNull();
    expect(store.watching()).toBe(false);
  });

  it('asks for the engine`s run.output frames only while a buffer is open', () => {
    const store = new RunOutputStore();
    expect(store.watching()).toBe(false);
    store.open(SESSION, { alreadyRunning: true, stage: 'plan' });
    expect(store.watching()).toBe(true);
    store.close(SESSION);
    expect(store.watching()).toBe(false);
  });

  it('stops asking for frames once the run it was watching has ended', () => {
    const store = opened(false);
    expect(store.watching()).toBe(true);
    store.finish(SESSION, { outcome: 'succeeded' });
    // The pane stays readable — that is why it freezes rather than clearing — but nothing more
    // can arrive in it, so the high-volume include comes back off.
    expect(store.viewOf(SESSION)).not.toBeNull();
    expect(store.watching()).toBe(false);
  });

  it('never asks for frames on behalf of a pane opened on an idle session', () => {
    const store = new RunOutputStore();
    store.open(SESSION, { alreadyRunning: false, stage: null, live: false });
    expect(store.watching()).toBe(false);
  });

  it('ignores a chunk for a session nobody is watching', () => {
    const store = new RunOutputStore();
    store.append('somebody-else', 'noise');
    expect(store.viewOf('somebody-else')).toBeNull();
  });
});

describe('the five things the pane can be looking at', () => {
  it('a live run that has done nothing yet SAYS so — an empty box reads as a broken one', () => {
    const shown = view(opened(false));
    expect(shown.state).toBe('waiting');
    expect(shown.lines).toEqual([]);
    expect(shown.notice).toContain('has not done anything yet');
  });

  it('a live run with output shows it, with no notice in the way', () => {
    const store = opened(false);
    store.append(SESSION, 'Reading the ticket…');
    const shown = view(store);
    expect(shown.state).toBe('streaming');
    expect(shown.lines).toEqual(['Reading the ticket…']);
    expect(shown.notice).toBe('');
  });

  it('a run joined mid-flight says the beginning was never kept, and invents none of it', () => {
    const store = opened(true);
    store.append(SESSION, 'a later line');
    const shown = view(store);
    expect(shown.joinedMidRun).toBe(true);
    expect(shown.notice).toContain('joined this run in progress');
    expect(shown.notice).toContain('is not kept');
    expect(shown.lines).toEqual(['a later line']);
  });

  it('keeps saying it even before the first line arrives after a mid-run join', () => {
    expect(view(opened(true)).notice).toContain('joined this run in progress');
  });

  it('freezes on a terminal line when the run ends while the pane is open', () => {
    const store = opened(false);
    store.append(SESSION, 'done thinking');
    store.finish(SESSION, { outcome: 'succeeded' });
    const shown = view(store);
    expect(shown.state).toBe('ended');
    expect(shown.ending).toContain('run ended');
    // The record is the artifact on disk; this pane never claims to be it.
    expect(shown.ending).toContain('artifact');
    expect(shown.lines).toEqual(['done thinking']);
  });

  it('a session with no run at all says that, rather than showing an empty stream', () => {
    const store = new RunOutputStore();
    store.open(SESSION, { alreadyRunning: false, stage: null, live: false });
    const shown = view(store);
    expect(shown.state).toBe('notStarted');
    expect(shown.notice).toContain('Nothing is running');
  });

  it('a line that arrives after the ending is refused — a frozen pane stays frozen', () => {
    const store = opened(false);
    store.finish(SESSION, { outcome: 'stopped' });
    store.append(SESSION, 'a straggler');
    expect(view(store).lines).toEqual([]);
  });
});

/**
 * Defect 5 — the pane's content changed underneath its sentences. It used to carry the agent's
 * occasional prose and now carries a work log (the reads, the edits, the commands, their capped
 * answers), so every state has to be re-read: "printed nothing" was the wrong question to ask
 * about an agent that is working hard and saying nothing.
 */
describe('the five states read as a work log, not as a print stream', () => {
  const ALL = [
    WAITING_NOTICE,
    JOINED_MID_RUN_NOTICE,
    NOT_STARTED_NOTICE,
    droppedNotice(12),
    endedNotice('succeeded'),
  ];

  it('waiting names the WORK that will appear, not the printing that may never happen', () => {
    expect(WAITING_NOTICE).toMatch(/has not done anything yet/);
    expect(WAITING_NOTICE).toMatch(/reads|edits|runs/);
  });

  it('a mid-run join claims only what it has, and only since the pane opened', () => {
    expect(JOINED_MID_RUN_NOTICE).toMatch(/since the pane opened/);
    expect(JOINED_MID_RUN_NOTICE).toMatch(/is not kept/);
  });

  it('an idle session says where the work would go', () => {
    expect(NOT_STARTED_NOTICE).toMatch(/Nothing is running/);
    expect(NOT_STARTED_NOTICE).toMatch(/while a stage is running/);
  });

  it('the ending says it is a summary of the work seen, and points at the record', () => {
    expect(endedNotice('succeeded')).toMatch(/summarised|summary/);
    expect(endedNotice('succeeded')).toMatch(/while the pane was open/);
    expect(endedNotice('succeeded')).toMatch(/artifact/);
  });

  it('no state describes the pane as the agent printing, or as a complete record', () => {
    for (const sentence of ALL) {
      expect(sentence).not.toMatch(/print/i);
      expect(sentence).not.toMatch(/\btranscript\b|\bcomplete\b|\bfull record\b/i);
    }
  });
});

/**
 * Defect 5, the third question — "shouldnt i be able to ... interact?". No: the runner spawns
 * `claude -p <prompt>` headless with no open stdin, so there is no channel to type into mid-run,
 * and the designed path is that an agent needing the human writes `AGENT_STATE=needs-input` and
 * STOPS. That is a real answer and the user has twice been told only the half of it that refuses.
 */
describe('what the pane says about interacting with a live run', () => {
  it('says what cannot be done AND the way through, while the run is live', () => {
    expect(view(opened(false)).interaction).toBe(INTERACTION_NOTE);
    // Cannot: type at it, interrupt it.
    expect(INTERACTION_NOTE).toMatch(/cannot/i);
    // The way through: it stops and asks, chat opens then, Stop keeps the work already written.
    expect(INTERACTION_NOTE).toMatch(/stops and asks/i);
    expect(INTERACTION_NOTE).toMatch(/chat/i);
    expect(INTERACTION_NOTE).toMatch(/Stop ends the run/);
    expect(INTERACTION_NOTE).toMatch(/already written/i);
  });

  it('keeps saying it once output is flowing — it is a standing rule, not an empty-state hint', () => {
    const store = opened(false);
    store.append(SESSION, 'Read src/foo.ts');
    expect(view(store).interaction).toBe(INTERACTION_NOTE);
  });

  it('drops it when the run has ended — there is nothing left to interrupt', () => {
    const store = opened(false);
    store.finish(SESSION, { outcome: 'succeeded' });
    expect(view(store).interaction).toBeNull();
  });

  it('drops it when nothing is running at all', () => {
    const store = new RunOutputStore();
    store.open(SESSION, { alreadyRunning: false, stage: null, live: false });
    expect(view(store).interaction).toBeNull();
  });
});
