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
