import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

/** Every module the extension's tests import directly, and which therefore must stay API-free. */
export function pureSourceFiles(): string[] {
  const files = [path.join(root, 'src/core-client.ts'), path.join(root, 'src/sse.ts')];
  const modelDir = path.join(root, 'src/model');
  for (const name of fs.readdirSync(modelDir)) {
    if (name.endsWith('.ts')) files.push(path.join(modelDir, name));
  }
  return files;
}

describe('MG-B1 pure-modules-are-vscode-free', () => {
  it('has pure modules to check', () => {
    expect(pureSourceFiles().length).toBeGreaterThanOrEqual(3);
  });

  it('never mentions the editor API in a pure module', () => {
    const offenders: string[] = [];
    for (const file of pureSourceFiles()) {
      const source = fs.readFileSync(file, 'utf8');
      if (source.includes('vscode')) offenders.push(path.relative(root, file));
    }
    expect(offenders).toEqual([]);
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
      'host.ts',
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
