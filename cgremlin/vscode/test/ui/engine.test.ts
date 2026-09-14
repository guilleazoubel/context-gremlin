/**
 * The engine's editor surface: activation, the first run, the two prompts, the log tail, the
 * config watcher and the live setting — against a fake editor host and a fake manager.
 *
 * The rules with teeth here are the ones whose wrong answer cancels a user's running agent: no
 * restart without consulting `GET /version`'s `activeRuns` (R21), no prompt when there is nothing
 * at stake, the engine left completely alone when its config does not load (R27), and deactivation
 * that disposes both watches without ever stopping a daemon other windows are using (R16, R30).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  EngineSurface,
  NOT_NOW,
  OPEN_CONFIG,
  RESTART,
  SHOW_LOG,
  STOP_ENGINE,
} from '../../src/ui/engine';
import {
  statusBarCommand,
  statusBarText,
  statusBarTooltip,
  statusBarWarning,
  type EngineStatus,
} from '../../src/ui/status-bar';
import { troubleMessage } from '../../src/model/engine-trouble';
import { FakeHost } from '../support/fake-host';
import {
  ConfigErrorLike,
  FakeBridge,
  FakeEngineManager,
  FAKE_PATHS,
} from '../support/fake-engine-manager';

const CONFIG = '/home/me/.cgremlin-core/core.json';
const LOG = FAKE_PATHS.engineLogPath;
const EXEC = '/path/to/node';
const ENGINE = '/ext/engine/engine.js';
/** What R20's login shell answers — the PATH the engine's own spawn is given. */
const LOGIN_PATH = '/opt/homebrew/bin:/usr/bin';

let host: FakeHost;
let manager: FakeEngineManager;
let bridge: FakeBridge;
let surface: EngineSurface;

function build(): EngineSurface {
  return new EngineSurface({
    host,
    manager,
    bridge,
    configPath: () => configPath,
    home: '/home/me',
    execPath: EXEC,
    enginePath: ENGINE,
    resolveLoginPath: async () => loginPath,
    // Recorded in the manager's own log so ordering assertions read as one sequence.
    reconnect: async () => {
      manager.calls.push('reconnect');
    },
    debounceMs: 500,
  });
}

let configPath = CONFIG;
let loginPath: string | null = LOGIN_PATH;

beforeEach(() => {
  host = new FakeHost();
  manager = new FakeEngineManager();
  bridge = new FakeBridge();
  configPath = CONFIG;
  loginPath = LOGIN_PATH;
  manager.current = { kind: 'running', version: '0.0.1', pid: 10, adopted: true };
  surface = build();
});

describe('activation', () => {
  it('starts the engine once, and connects only after it reports running', async () => {
    host.files.set(CONFIG, '{}');
    await surface.bootstrap();
    expect(manager.calls).toEqual(['ensureRunning:auto', 'reconnect']);
    expect(host.callsOf('spawnCapture')).toHaveLength(0);
  });

  it('does not connect when the engine did not come up', async () => {
    host.files.set(CONFIG, '{}');
    manager.current = { kind: 'failed', reason: 'boom', logTail: [] };
    await surface.bootstrap();
    expect(manager.calls).toEqual(['ensureRunning:auto']);
  });

  it('arms the config watcher on the file the setting names', async () => {
    host.files.set(CONFIG, '{}');
    await surface.bootstrap();
    expect([...host.watches.keys()]).toContain(CONFIG);
  });
});

describe('first run (R5)', () => {
  it('asks gh who the user is, has the engine write the template, then opens it', async () => {
    host.spawnResults.set('gh', { code: 0, stdout: 'someone\n', stderr: '' });
    await surface.bootstrap();
    await surface.settled();

    const spawns = host.callsOf('spawnCapture');
    expect(spawns[0].args[0]).toBe('gh');
    expect(spawns[0].args[1]).toEqual(['api', 'user', '--jq', '.login']);
    expect(spawns[1].args[0]).toBe(EXEC);
    expect(spawns[1].args[1]).toEqual([
      ENGINE,
      'config',
      'init',
      '--config',
      CONFIG,
      '--me',
      'someone',
    ]);
    expect(host.kinds().filter((k) => k !== 'appendOutput' && k !== 'watchFile')).toEqual([
      'spawnCapture',
      'spawnCapture',
      'openTextDocument',
      'showInformationMessage',
    ]);
    expect(manager.calls).toEqual(['ensureRunning:auto', 'reconnect']);
  });

  it('asks the user when gh fails, and writes nothing at all when they cancel', async () => {
    host.spawnResults.set('gh', { code: 1, stdout: '', stderr: 'gh: not logged in' });
    host.inputBoxAnswers = [undefined];
    await surface.bootstrap();
    await surface.settled();

    expect(host.callsOf('showInputBox')).toHaveLength(1);
    expect(host.callsOf('spawnCapture').filter((c) => c.args[0] === EXEC)).toHaveLength(0);
    expect(host.callsOf('writeFile')).toHaveLength(0);
    const warnings = host.callsOf('showWarningMessage');
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0].args[0])).toContain('cgremlin.configPath');
    expect(manager.calls).toEqual([]);
  });

  it('asks gh with the login shell PATH the engine itself is spawned with (R20)', async () => {
    host.spawnResults.set('gh', { code: 0, stdout: 'someone\n', stderr: '' });
    await surface.bootstrap();
    await surface.settled();

    const gh = host.callsOf('spawnCapture')[0];
    expect(gh.args[0]).toBe('gh');
    expect((gh.args[2] as { env?: Record<string, string | undefined> }).env?.PATH).toBe(LOGIN_PATH);
  });

  it('falls back to this process own PATH when the login shell does not answer', async () => {
    loginPath = null;
    host.spawnResults.set('gh', { code: 0, stdout: 'someone\n', stderr: '' });
    await surface.bootstrap();
    await surface.settled();

    const gh = host.callsOf('spawnCapture')[0];
    expect((gh.args[2] as { env?: Record<string, string | undefined> }).env).toBeUndefined();
  });

  it('uses a typed login when gh cannot answer', async () => {
    host.spawnResults.set('gh', { code: 1, stdout: '', stderr: '' });
    host.inputBoxAnswers = ['typed-login'];
    await surface.bootstrap();
    await surface.settled();
    const init = host.callsOf('spawnCapture')[1];
    expect(init.args[1]).toEqual([ENGINE, 'config', 'init', '--config', CONFIG, '--me', 'typed-login']);
  });
});

describe('a config that does not load', () => {
  it('shows the engine wording verbatim with an Open action, and touches nothing', async () => {
    host.files.set(CONFIG, '{}');
    bridge.failWith = new ConfigErrorLike('core.json: repos[0] is not a git URL');
    host.messageAnswers = [OPEN_CONFIG];
    await surface.bootstrap();
    await surface.settled();

    const warnings = host.callsOf('showWarningMessage');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].args[0]).toBe('core.json: repos[0] is not a git URL');
    expect(warnings[0].args[2]).toEqual([OPEN_CONFIG]);
    expect(host.callsOf('openTextDocument').map((c) => c.args[0])).toEqual([CONFIG]);
    expect(manager.calls).toEqual([]);
  });

  it('reports anything that is not a ConfigError in the output channel only', async () => {
    host.files.set(CONFIG, '{}');
    bridge.failWith = new Error('EACCES');
    await surface.bootstrap();
    expect(host.callsOf('showWarningMessage')).toHaveLength(0);
    expect(host.output.some((line) => line.includes('EACCES'))).toBe(true);
  });
});

describe('a version mismatch (R2 as amended by R21)', () => {
  const mismatch = { kind: 'mismatch', running: '0.0.2', bundled: '0.0.1', pid: 10 } as const;

  beforeEach(async () => {
    host.files.set(CONFIG, '{}');
    await surface.bootstrap();
    manager.calls.length = 0;
  });

  it('asks, modally, when something is running — and only once per window', async () => {
    manager.runs = 3;
    host.messageAnswers = [NOT_NOW];
    manager.emit({ ...mismatch });
    manager.emit({ ...mismatch });
    manager.emit({ ...mismatch });
    await surface.settled();

    const asked = host.callsOf('showInformationMessage');
    expect(asked).toHaveLength(1);
    expect(String(asked[0].args[0])).toContain('0.0.2');
    expect(String(asked[0].args[0])).toContain('0.0.1');
    expect(asked[0].args[1]).toEqual({ modal: true });
    expect(asked[0].args[2]).toEqual([RESTART, NOT_NOW, SHOW_LOG]);
    expect(manager.countOf('restart:user')).toBe(0);
  });

  it('restarts once when the user says so', async () => {
    manager.runs = 1;
    host.messageAnswers = [RESTART];
    manager.emit({ ...mismatch });
    await surface.settled();
    expect(manager.countOf('restart:user')).toBe(1);
  });

  it('restarts silently when nothing is running, with one line in the channel', async () => {
    manager.runs = 0;
    manager.emit({ ...mismatch });
    await surface.settled();
    expect(host.callsOf('showInformationMessage')).toHaveLength(0);
    expect(manager.countOf('restart:auto')).toBe(1);
    expect(host.output.filter((l) => l.includes('nothing is running'))).toHaveLength(1);
  });
});

describe('a foreign server on the socket', () => {
  const FOREIGN_TEXT = troubleMessage({ kind: 'foreign', socketPath: FAKE_PATHS.socketPath });

  beforeEach(async () => {
    host.files.set(CONFIG, '{}');
    await surface.bootstrap();
    manager.calls.length = 0;
  });

  it('P10 — explains which socket is held in the channel, and raises no popup at all', async () => {
    manager.emit({ kind: 'foreign' });
    manager.emit({ kind: 'foreign' });
    await surface.settled();

    // The panel's trouble row and the status bar already carry this sentence and offer the same
    // two actions; a popup on top of them is the same fact three times, over what the user was
    // doing and for something the user did not do.
    expect(host.callsOf('showWarningMessage')).toEqual([]);
    expect(host.callsOf('showInformationMessage')).toEqual([]);
    expect(host.output.filter((line) => line.includes(FOREIGN_TEXT))).toHaveLength(1);
    expect(host.output.some((line) => line.includes(FAKE_PATHS.socketPath))).toBe(true);
    expect(manager.calls).toEqual([]);
  });

  it('P10 — the way out is the panel row and the status bar, both fed by the published health', () => {
    const seen: EngineStatus[] = [];
    surface.onState((status) => seen.push(status));
    manager.emit({ kind: 'foreign' });
    expect(seen.at(-1)).toEqual({ kind: 'foreign', socketPath: FAKE_PATHS.socketPath });
  });

  it('says so again on every transition into foreign, however many times it happens', async () => {
    for (let episode = 0; episode < 3; episode += 1) {
      manager.emit({ kind: 'foreign' });
      manager.emit({ kind: 'foreign' });
      manager.emit({ kind: 'running', version: '0.0.1', pid: 10, adopted: true });
    }
    await surface.settled();
    expect(host.output.filter((line) => line.includes(FOREIGN_TEXT))).toHaveLength(3);
    expect(host.callsOf('showWarningMessage')).toEqual([]);
  });

  it('reports its health as foreign, with the socket the config resolved', async () => {
    manager.emit({ kind: 'foreign' });
    await surface.settled();
    expect(surface.health()).toEqual({ kind: 'foreign', socketPath: FAKE_PATHS.socketPath });
  });

  it('reconnects the panel when the probe finally adopts a usable engine', async () => {
    manager.emit({ kind: 'foreign' });
    await surface.settled();
    manager.calls.length = 0;
    manager.emit({ kind: 'running', version: '0.0.1', pid: 10, adopted: true });
    await surface.settled();
    expect(manager.calls).toEqual(['reconnect']);
  });
});

describe('an engine that answers but is not one we can use (GET /config 404)', () => {
  beforeEach(async () => {
    host.files.set(CONFIG, '{}');
    await surface.bootstrap();
    manager.calls.length = 0;
  });

  it('surfaces exactly what a foreign probe does', async () => {
    const seen: EngineStatus[] = [];
    surface.onState((status) => seen.push(status));
    surface.reportUnusable();
    await surface.settled();

    expect(surface.health()).toEqual({ kind: 'foreign', socketPath: FAKE_PATHS.socketPath });
    expect(seen.at(-1)).toEqual({ kind: 'foreign', socketPath: FAKE_PATHS.socketPath });
    // P10: same surface as a foreign probe — which is now the panel row, not a popup.
    expect(host.callsOf('showWarningMessage')).toEqual([]);
    expect(
      host.output.filter((line) =>
        line.includes(troubleMessage({ kind: 'foreign', socketPath: FAKE_PATHS.socketPath })),
      ),
    ).toHaveLength(1);
  });

  it('says it once, not once per failed connect attempt', async () => {
    surface.reportUnusable();
    surface.reportUnusable();
    await surface.settled();
    expect(
      host.output.filter((line) =>
        line.includes(troubleMessage({ kind: 'foreign', socketPath: FAKE_PATHS.socketPath })),
      ),
    ).toHaveLength(1);
  });

  it('is forgotten as soon as the manager reports a state of its own', async () => {
    surface.reportUnusable();
    await surface.settled();
    manager.emit({ kind: 'running', version: '0.0.1', pid: 10, adopted: true });
    expect(surface.health()).toMatchObject({ kind: 'running' });
  });
});

describe('the engine commands', () => {
  beforeEach(async () => {
    host.files.set(CONFIG, '{}');
    for (const disposable of surface.register()) void disposable;
    await surface.bootstrap();
    manager.calls.length = 0;
  });

  it('starts and restarts on the user trigger', async () => {
    await host.invoke('cgremlin.engine.start');
    await host.invoke('cgremlin.engine.restart');
    expect(manager.calls).toEqual(['ensureRunning:user', 'restart:user']);
  });

  it('confirms a stop with the shared-daemon fact and the running count (R16/R21)', async () => {
    manager.runs = 2;
    host.messageAnswers = [STOP_ENGINE];
    await host.invoke('cgremlin.engine.stop');
    const asked = host.callsOf('showWarningMessage');
    expect(asked).toHaveLength(1);
    expect(String(asked[0].args[0])).toContain('shared by every window');
    expect(String(asked[0].args[0])).toContain('2 running item(s)');
    expect(asked[0].args[1]).toEqual({ modal: true });
    expect(manager.countOf('stop')).toBe(1);
  });

  it('stops nothing when the confirmation is dismissed', async () => {
    manager.runs = 0;
    host.messageAnswers = [undefined];
    await host.invoke('cgremlin.engine.stop');
    expect(manager.countOf('stop')).toBe(0);
  });

  it('does not ask, or signal, a second time while it is already stopping (R23)', async () => {
    manager.current = { kind: 'stopping', since: 0, pid: 10, elapsedMs: 46_000 };
    await host.invoke('cgremlin.engine.stop');
    expect(host.callsOf('showWarningMessage')).toHaveLength(0);
    expect(manager.countOf('stop')).toBe(0);
  });

  it('shows the channel and names the log path the engine derived, in it (MG-C6, P10)', async () => {
    await host.invoke('cgremlin.engine.showLog');
    expect(host.outputShown).toHaveLength(1);
    expect(host.output.filter((line) => line.includes(LOG))).toHaveLength(1);
    expect(host.callsOf('showInformationMessage')).toEqual([]);
  });
});

describe('the log tail (R11)', () => {
  it('starts at the current end of file and only reports what arrives after', async () => {
    host.files.set(CONFIG, '{}');
    host.files.set(LOG, 'old one\nold two\nold three\n');
    await surface.bootstrap();
    expect(host.output.filter((line) => line.startsWith('old'))).toEqual([]);

    host.append(LOG, 'fresh line\n');
    expect(host.output.filter((line) => line.startsWith('old') || line === 'fresh line')).toEqual([
      'fresh line',
    ]);
  });

  it('starts again from the beginning when the log was rotated under it', async () => {
    host.files.set(CONFIG, '{}');
    host.files.set(LOG, 'x'.repeat(50) + '\n');
    await surface.bootstrap();
    host.files.set(LOG, '');
    host.append(LOG, 'after the rotate\n');
    expect(host.output).toContain('after the rotate');
  });
});

describe('the config watcher (R6, R21, R27)', () => {
  beforeEach(async () => {
    host.files.set(CONFIG, '{}');
    await surface.bootstrap();
    manager.calls.length = 0;
    bridge.loads.length = 0;
  });

  it('coalesces two saves inside the debounce window into one action', async () => {
    manager.runs = 0;
    host.touch(CONFIG, '{"me":"a"}');
    host.touch(CONFIG, '{"me":"b"}');
    host.flushTimeouts();
    await surface.settled();
    expect(bridge.loads).toEqual([CONFIG]);
    expect(manager.countOf('restart:auto')).toBe(1);
  });

  it('validates through the engine loader before anything is restarted, then re-asserts 0600', async () => {
    manager.runs = 0;
    host.modes.set(CONFIG, 0o644);
    host.touch(CONFIG, '{"me":"changed"}');
    host.flushTimeouts();
    await surface.settled();
    const chmod = host.callsOf('chmod');
    expect(chmod).toHaveLength(1);
    expect(chmod[0].args).toEqual([CONFIG, 0o600]);
    // The load happened first: the restart is downstream of a config that actually loads.
    expect(bridge.loads).toEqual([CONFIG]);
    expect(manager.calls).toEqual(['activeRuns', 'restart:auto']);
  });

  it('asks before restarting when the engine has work in flight', async () => {
    manager.runs = 4;
    host.messageAnswers = [NOT_NOW];
    host.touch(CONFIG, '{"me":"first"}');
    host.flushTimeouts();
    await surface.settled();
    const asked = host.callsOf('showInformationMessage');
    expect(asked).toHaveLength(1);
    expect(asked[0].args[1]).toEqual({ modal: true });
    expect(String(asked[0].args[0])).toContain('4 running item(s)');
    expect(manager.countOf('restart:auto')).toBe(0);

    host.messageAnswers = [RESTART];
    host.touch(CONFIG, '{"me":"second"}');
    host.flushTimeouts();
    await surface.settled();
    expect(manager.countOf('restart:auto')).toBe(1);
  });

  it('just starts the engine when nothing is answering', async () => {
    manager.runs = null;
    host.touch(CONFIG, '{"me":"typed"}');
    host.flushTimeouts();
    await surface.settled();
    expect(manager.calls).toEqual(['activeRuns', 'ensureRunning:auto']);
  });

  it('logs a chmod that fails and restarts anyway', async () => {
    manager.runs = 0;
    host.chmodError = new Error('EPERM');
    host.modes.set(CONFIG, 0o644);
    host.touch(CONFIG, '{"me":"changed"}');
    host.flushTimeouts();
    await surface.settled();
    expect(host.logs.filter((l) => l.includes('0600'))).toHaveLength(1);
    expect(manager.countOf('restart:auto')).toBe(1);
  });

  it('leaves the engine completely alone on a ConfigError, and stays armed', async () => {
    bridge.failWith = new ConfigErrorLike('core.json: me must not be empty');
    host.touch(CONFIG, '{bad');
    host.flushTimeouts();
    await surface.settled();
    expect(manager.calls).toEqual([]);
    const warnings = host.callsOf('showWarningMessage');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].args[0]).toBe('core.json: me must not be empty');

    // The next save is the user's fix attempt: the watcher must still be listening.
    manager.runs = 0;
    host.touch(CONFIG, '{"me":"someone"}');
    host.flushTimeouts();
    await surface.settled();
    expect(manager.countOf('restart:auto')).toBe(1);
  });
});

/**
 * The flap this watcher was rewritten for.
 *
 * `fs.watch` reports *events*, not changes, and on macOS a `chmod` on the watched file is itself
 * an event — so a watcher that chmods unconditionally feeds itself: chmod → event → validate →
 * chmod → restart, forever, at the period of one engine restart. The fix is to address the file
 * by its content: an event whose digest matches the one already acted on ends the pass before
 * the chmod and before any restart decision, and the chmod itself only happens when the mode is
 * genuinely not 0600.
 */
describe('the config watcher is content-addressed (the chmod flap)', () => {
  beforeEach(async () => {
    host.files.set(CONFIG, '{"me":"seed"}');
    await surface.bootstrap();
    manager.calls.length = 0;
    bridge.loads.length = 0;
    manager.runs = 0;
  });

  /** Runs whatever the debounce queued, repeatedly, so a self-feeding loop shows up as a count. */
  async function drain(rounds = 6): Promise<void> {
    for (let round = 0; round < rounds; round += 1) {
      host.flushTimeouts();
      await surface.settled();
    }
  }

  it('does nothing at all for an event that left the bytes alone, whatever the mode', async () => {
    host.modes.set(CONFIG, 0o644);
    host.touch(CONFIG);
    await drain();
    expect(host.callsOf('chmod')).toHaveLength(0);
    expect(bridge.loads).toEqual([]);
    expect(manager.calls).toEqual([]);
  });

  it('chmods once and restarts once when a chmod fires the watch again (no loop)', async () => {
    host.modes.set(CONFIG, 0o644);
    // The macOS fact, in the fake: the chmod itself fires the watcher.
    host.chmodHook = () => host.touch(CONFIG);
    host.touch(CONFIG, '{"me":"changed"}');
    await drain();
    expect(host.callsOf('chmod')).toHaveLength(1);
    expect(manager.countOf('restart:auto')).toBe(1);
  });

  it('never even chmods when a chmod-only storm follows a settled config', async () => {
    host.modes.set(CONFIG, 0o644);
    host.chmodHook = () => host.touch(CONFIG);
    for (let i = 0; i < 20; i += 1) host.touch(CONFIG);
    await drain(20);
    expect(host.callsOf('chmod')).toHaveLength(0);
    expect(manager.countOf('restart:auto')).toBe(0);
  });

  it('restarts on changed content, and leaves a mode that is already 0600 alone', async () => {
    host.touch(CONFIG, '{"me":"changed"}');
    await drain();
    expect(host.callsOf('chmod')).toHaveLength(0);
    expect(manager.countOf('restart:auto')).toBe(1);
  });

  it('re-seeds its digest from the config it resolved, so the first save after one is seen', async () => {
    host.touch(CONFIG, '{"me":"one"}');
    await drain();
    host.touch(CONFIG, '{"me":"two"}');
    await drain();
    expect(manager.countOf('restart:auto')).toBe(2);
  });
});

describe('a changed setting (D5, R7)', () => {
  beforeEach(async () => {
    host.files.set(CONFIG, '{}');
    await surface.bootstrap();
    manager.calls.length = 0;
    bridge.loads.length = 0;
  });

  it('re-resolves, re-points, reconnects and starts — and stops nothing', async () => {
    const other = '/home/me/elsewhere/core.json';
    bridge.paths = { ...FAKE_PATHS, socketPath: '/home/me/elsewhere/engine.sock' };
    configPath = other;
    await surface.settingsChanged();

    expect(bridge.loads).toEqual([other]);
    expect(surface.paths()?.socketPath).toBe('/home/me/elsewhere/engine.sock');
    expect([...host.watches.keys()]).toContain(other);
    expect(manager.calls).toEqual(['reconnect', 'ensureRunning:auto']);
    expect(manager.countOf('stop')).toBe(0);
  });

  it('does nothing at all when only the notification level changed', async () => {
    await surface.settingsChanged();
    expect(bridge.loads).toEqual([]);
    expect(manager.calls).toEqual([]);
  });
});

describe('the status bar (R17, R23)', () => {
  const domain = {
    connected: true,
    needYou: 2,
    currentSessionId: null,
    currentPhase: null,
    currentWorktreePath: null,
    sourceTrouble: null,
  };

  function withEngine(engine: EngineStatus) {
    return { ...domain, engine };
  }

  it('leaves the healthy text exactly as it was', () => {
    expect(statusBarText(withEngine({ kind: 'running' }))).toBe(
      '$(folder) cgremlin: no repo open — 2 need you',
    );
    expect(statusBarCommand(withEngine({ kind: 'running' }))).toBe(
      'workbench.view.extension.cgremlin',
    );
    expect(statusBarText({ ...domain, connected: false, engine: { kind: 'unknown' } })).toBe(
      '$(circle-slash) cgremlin: offline',
    );
  });

  it('renders each engine state with its own text and click target', () => {
    expect(statusBarText(withEngine({ kind: 'starting' }))).toContain('starting…');
    expect(statusBarCommand(withEngine({ kind: 'starting' }))).toBe('cgremlin.engine.showLog');

    expect(statusBarText(withEngine({ kind: 'stopping', elapsedMs: 46_200 }))).toBe(
      '$(sync~spin) cgremlin: stopping… 46s',
    );
    expect(statusBarCommand(withEngine({ kind: 'stopping' }))).toBe('cgremlin.engine.showLog');

    expect(statusBarText(withEngine({ kind: 'stopped' }))).toContain('engine stopped');
    expect(statusBarCommand(withEngine({ kind: 'stopped' }))).toBe('cgremlin.engine.start');

    expect(statusBarText(withEngine({ kind: 'mismatch' }))).toContain('version mismatch');
  });

  it('says the engine is not usable, and re-probes on a click, while it is foreign', () => {
    const foreign = withEngine({ kind: 'foreign', socketPath: FAKE_PATHS.socketPath });
    expect(statusBarText(foreign)).toBe('$(warning) cgremlin: engine not usable');
    expect(statusBarCommand(foreign)).toBe('cgremlin.engine.start');
    expect(statusBarWarning(foreign)).toBe(true);
    expect(statusBarTooltip(foreign)).toContain(FAKE_PATHS.socketPath);
  });

  it('says the engine failed, and shows the log on a click', () => {
    const failed = withEngine({ kind: 'failed', reason: 'boom' });
    expect(statusBarText(failed)).toBe('$(warning) cgremlin: engine failed');
    expect(statusBarCommand(failed)).toBe('cgremlin.engine.showLog');
    expect(statusBarWarning(failed)).toBe(true);
    expect(statusBarTooltip(failed)).toContain('boom');
  });

  it('colours nothing when the engine is merely busy or healthy', () => {
    expect(statusBarWarning(withEngine({ kind: 'running' }))).toBe(false);
    expect(statusBarWarning(withEngine({ kind: 'starting' }))).toBe(false);
  });

  it('is fed by the surface as the manager changes state', async () => {
    host.files.set(CONFIG, '{}');
    const seen: EngineStatus[] = [];
    surface.onState((status) => seen.push(status));
    await surface.bootstrap();
    manager.emit({ kind: 'stopping', since: 0, pid: 10, elapsedMs: 46_000 });
    expect(seen.at(-1)).toEqual({
      kind: 'stopping',
      elapsedMs: 46_000,
      socketPath: FAKE_PATHS.socketPath,
    });
  });
});

describe('deactivation (R16, R30)', () => {
  it('disposes both watches, stops no engine, and goes quiet', async () => {
    host.files.set(CONFIG, '{}');
    host.files.set(LOG, '');
    await surface.bootstrap();
    manager.emit({ kind: 'running', version: '0.0.1', pid: 10, adopted: false });
    expect([...host.watches.keys()].sort()).toEqual([CONFIG, LOG].sort());
    manager.calls.length = 0;

    const watched = [...host.watches.entries()];
    surface.dispose();
    expect(watched.every(([, entry]) => entry.disposed === 1)).toBe(true);
    expect(manager.countOf('stop')).toBe(0);

    // Nothing that happens afterwards reaches the channel or the engine.
    const outputBefore = host.output.length;
    for (const [, entry] of watched) entry.callback();
    host.flushTimeouts();
    await surface.settled();
    expect(host.output).toHaveLength(outputBefore);
    expect(manager.calls).toEqual([]);
  });
});

/**
 * Two windows, one engine. A config-save latch that is kept per `EngineManager` instance (R26b)
 * is per *window* — so a second window that never restarted this identity itself would restart it
 * again, cascading (pid1 → pid2 from window A, then pid2 → pid3 from window B, for one save). The
 * fix does not depend on the two windows sharing any state: it asks whether the *engine itself*
 * already has today's bytes, by comparing `GET /version`'s `startedAt` against the config's own
 * mtime. `manager` here stands for the one physical engine both windows' managers would probe —
 * `startedAtAfterRestart` moves it forward the way a real restart would.
 */
describe('a config save restarts the engine at most once, however many windows are watching', () => {
  const STALE_STARTED_AT = '2026-01-01T00:00:00.000Z';
  const CONFIG_MTIME = Date.parse('2026-01-01T00:02:00.000Z');
  const FRESH_STARTED_AT = '2026-01-01T00:05:00.000Z';

  let hostB: FakeHost;
  let surfaceB: EngineSurface;

  beforeEach(async () => {
    manager.runs = 0;
    manager.startedAt = STALE_STARTED_AT;
    host.files.set(CONFIG, '{"me":"seed"}');
    hostB = new FakeHost();
    hostB.files.set(CONFIG, '{"me":"seed"}');
    surfaceB = new EngineSurface({
      host: hostB,
      manager,
      bridge,
      configPath: () => configPath,
      home: '/home/me',
      execPath: EXEC,
      enginePath: ENGINE,
      resolveLoginPath: async () => loginPath,
      reconnect: async () => undefined,
      debounceMs: 500,
    });
    await surface.bootstrap();
    await surfaceB.bootstrap();
    manager.calls.length = 0;
  });

  it('restarts once for window A, then skips window B once the engine already has the change', async () => {
    host.mtimes.set(CONFIG, CONFIG_MTIME);
    hostB.mtimes.set(CONFIG, CONFIG_MTIME);
    manager.startedAtAfterRestart = FRESH_STARTED_AT;

    host.touch(CONFIG, '{"me":"changed"}');
    host.flushTimeouts();
    await surface.settled();
    expect(manager.countOf('restart:auto')).toBe(1);
    expect(manager.startedAt).toBe(FRESH_STARTED_AT);

    // Window B's own watcher fires for the very same save, after A's restart has landed.
    hostB.touch(CONFIG, '{"me":"changed"}');
    hostB.flushTimeouts();
    await surfaceB.settled();
    expect(manager.countOf('restart:auto')).toBe(1);
    expect(hostB.logs.some((l) => l.startsWith('engine.restart_skipped_fresh'))).toBe(true);
  });

  it('does not even ask about active runs once it knows the engine already has the change', async () => {
    host.mtimes.set(CONFIG, CONFIG_MTIME);
    manager.startedAt = FRESH_STARTED_AT; // already newer than the save being processed
    host.touch(CONFIG, '{"me":"changed"}');
    host.flushTimeouts();
    await surface.settled();
    expect(manager.calls).toEqual(['engineStartedAt']);
  });

  it('restarts normally when the engine really does predate the change (no mtime on record)', async () => {
    // No `host.mtimes` entry at all — the real host's `fileMtimeMs` returning null (a stat that
    // failed) must fall through to the old behaviour, not skip a restart it cannot justify.
    host.touch(CONFIG, '{"me":"changed"}');
    host.flushTimeouts();
    await surface.settled();
    expect(manager.calls).toEqual(['activeRuns', 'restart:auto']);
  });
});
