import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

function tsFilesIn(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => path.join(dir, name));
}

/** Every module the extension's tests import directly, and which therefore must stay API-free. */
export function pureSourceFiles(): string[] {
  const files = [path.join(root, 'src/core-client.ts'), path.join(root, 'src/sse.ts')];
  files.push(...tsFilesIn(path.join(root, 'src/model')));
  // `src/engine/*` joins the list in Phase 8: the manager is a state machine with injected ports
  // and the bridge only ever talks to the engine bundle, so neither has any business naming the
  // editor API — not even in a comment (R30, and the plain `includes` check below).
  files.push(...tsFilesIn(path.join(root, 'src/engine')));
  return files;
}

/**
 * The rule the check below enforces, extracted so it can be tested on its own: a pure module may
 * not carry the editor API's module name *at all*, prose included. That is stricter than the
 * import regex the whole-tree half uses, and it is deliberate — R30, because the file whose whole
 * job is to talk to the engine bundle is exactly the one that would casually mention the editor.
 */
export function mentionsEditorApi(source: string): boolean {
  return source.includes('vscode');
}

describe('MG-B1 pure-modules-are-vscode-free', () => {
  it('has pure modules to check', () => {
    expect(pureSourceFiles().length).toBeGreaterThanOrEqual(3);
  });

  it('covers the work-item view model (B1)', () => {
    const names = pureSourceFiles().map((file) => path.basename(file));
    expect(names).toContain('work-items.ts');
  });

  it('covers the engine modules', () => {
    const engine = pureSourceFiles()
      .filter((file) => path.dirname(file).endsWith(path.join('src', 'engine')))
      .map((file) => path.basename(file))
      .sort();
    expect(engine).toContain('bridge.ts');
  });

  it('never mentions the editor API in a pure module', () => {
    const offenders: string[] = [];
    for (const file of pureSourceFiles()) {
      const source = fs.readFileSync(file, 'utf8');
      if (mentionsEditorApi(source)) offenders.push(path.relative(root, file));
    }
    expect(offenders).toEqual([]);
  });

  it('flags a pure module that merely mentions the editor API in a comment', () => {
    expect(mentionsEditorApi('// adapts one vscode.window call\nexport const a = 1;\n')).toBe(true);
    expect(mentionsEditorApi('// adapts one editor call\nexport const a = 1;\n')).toBe(false);
  });
});

/**
 * MG-B1, deliberately widened for `src/webview/**` (R40, spec §5).
 *
 * A webview module calls `acquireVsCodeApi()` and styles with `var(--vscode-*)`, so the plain
 * `includes('vscode')` rule above is unsatisfiable there and it does NOT join `pureSourceFiles()`.
 * It gets the narrower rule instead — it may never *import* the editor module, because it runs in
 * a browser context where that module does not exist — and the two-file import count below is
 * what stops the widening from becoming a hole.
 */
describe('MG-B1 (widened) the webview bundles import no editor module', () => {
  const dir = path.join(root, 'src/webview');
  const IMPORTS_VSCODE = /(?:from\s+'vscode'|require\('vscode'\)|import\('vscode'\))/;

  it('has webview entry points to check', () => {
    const names = fs.readdirSync(dir).filter((name) => name.endsWith('.ts')).sort();
    expect(names).toContain('item-tab.ts');
    expect(names).toContain('panel.ts');
  });

  it('imports the editor module nowhere under src/webview', () => {
    const offenders = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => IMPORTS_VSCODE.test(fs.readFileSync(path.join(dir, name), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('is not on the pure list, and the pure list is unchanged by its existence', () => {
    const pure = pureSourceFiles().map((file) => path.relative(root, file));
    expect(pure.filter((file) => file.startsWith('src/webview'))).toEqual([]);
  });
});

/**
 * The stronger half of the same rule: the *whole* extension touches the editor API in exactly two
 * files. `ui/*` takes its surface as a parameter object, which is the only reason the command
 * wiring above can be unit-tested at all.
 */
describe('MG-B1 the editor API has exactly two entry points', () => {
  const ALLOWED = ['src/extension.ts', 'src/settings.ts'];

  function allSourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...allSourceFiles(full));
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  // Prose is allowed to name the API (a `ui/*` module documents which real call it adapts and
  // passes built-in command ids like `vscode.openFolder` through); *importing* it is not.
  const IMPORTS_VSCODE = /(?:from\s+'vscode'|require\('vscode'\))/;

  it('imports vscode only in extension.ts and settings.ts', () => {
    const offenders = allSourceFiles(path.join(root, 'src'))
      .filter((file) => IMPORTS_VSCODE.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file))
      .sort();
    expect(offenders).toEqual(ALLOWED);
  });

  it('covers every ui module', () => {
    const ui = allSourceFiles(path.join(root, 'src/ui')).map((f) => path.basename(f)).sort();
    expect(ui).toEqual([
      'commands.ts',
      'engine.ts',
      'host.ts',
      'item-tab.ts',
      'notifications.ts',
      'preview.ts',
      'refresh.ts',
      'status-bar.ts',
      'terminal.ts',
      'tree.ts',
      'wiring.ts',
    ]);
  });
});

function everyFileUnder(dir: string, keep: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...everyFileUnder(full, keep));
    else if (keep(entry.name)) out.push(full);
  }
  return out;
}

function hits(files: string[], needle: RegExp): string[] {
  const out: string[] = [];
  for (const file of files) {
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (needle.test(line)) out.push(`${path.relative(root, file)}:${i + 1}`);
      });
  }
  return out;
}

function packageSources(): string[] {
  return [
    ...everyFileUnder(path.join(root, 'src'), (n) => n.endsWith('.ts')),
    ...everyFileUnder(path.join(root, 'test'), (n) => n.endsWith('.ts')),
    path.join(root, 'package.json'),
    path.join(root, 'README.md'),
  ];
}

/**
 * MG-C3: there is exactly one setting that names a path, and it is `cgremlin.configPath`. The
 * socket comes from the engine's own config loader, so a second, socket-naming setting reappearing
 * anywhere — manifest, sources, tests or the README — is the regression this guard catches. The
 * word `socketPath` itself survives, but only as client plumbing and as the engine's own field.
 */
describe('MG-C3 socket-setting-is-gone', () => {
  it('has no socket-path setting anywhere in the package', () => {
    expect(hits(packageSources(), /cgremlin\.socketPath/)).toEqual([]);
  });

  it('contributes exactly configPath and notificationLevel', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
    };
    const properties = manifest.contributes.configuration.properties;
    expect(Object.keys(properties).sort()).toEqual([
      'cgremlin.configPath',
      'cgremlin.notificationLevel',
    ]);
    expect(properties['cgremlin.configPath'].default).toBe('~/.cgremlin-core/core.json');
  });
});

/**
 * MG-C7: the engine is started by the manager, not by typing a shell command into a terminal that
 * needs `cgremlin-core` on `PATH`. The old start-engine command id is replaced rather than
 * aliased (R12), so its name must be gone from the whole package. (The integration harness has an
 * unrelated helper of a similar name, which is why this pins the command id and not the word.)
 */
describe('MG-C7 no-engine-start-via-terminal', () => {
  it('has no start-engine command id left anywhere', () => {
    expect(hits(packageSources(), /cgremlin\.startEngine/)).toEqual([]);
  });

  it('sends no serve command to a terminal', () => {
    const files = everyFileUnder(path.join(root, 'src'), (n) => n.endsWith('.ts'));
    const offenders = files.filter((file) =>
      fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .some((line) => line.includes('sendText') && line.includes('serve')),
    );
    expect(offenders).toEqual([]);
  });

  it('contributes the four engine commands', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      contributes: { commands: { command: string }[] };
    };
    const engine = manifest.contributes.commands
      .map((c) => c.command)
      .filter((c) => c.startsWith('cgremlin.engine.'))
      .sort();
    expect(engine).toEqual([
      'cgremlin.engine.restart',
      'cgremlin.engine.showLog',
      'cgremlin.engine.start',
      'cgremlin.engine.stop',
    ]);
  });
});

/**
 * MG-C6: the extension derives no state path of its own. The socket, the log, the pid file and the
 * session/worktree directories all come back from one call into the bundled engine's own config
 * loader, so a hand-joined `engine.sock`/`engine.log` — or any reference to the legacy state dir
 * (MG-C4) — under `src` is the regression. Bare field names like `worktreesDir` are the engine's
 * own answer being *read*, which is the whole point, so they are not matched.
 */
describe('MG-C6 extension-derives-no-state-paths', () => {
  it('joins no state path by hand under src', () => {
    const files = everyFileUnder(path.join(root, 'src'), (n) => n.endsWith('.ts'));
    expect(hits(files, /engine\.sock|engine\.log|\.cgremlin\//)).toEqual([]);
  });
});
