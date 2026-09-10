/**
 * MG-C8 `vsix-is-self-contained-and-lean`.
 *
 * The packaged extension must carry the engine and nothing else: the two esbuild bundles and the
 * compiled extension, with no `node_modules/` symlink farm (that is what `--no-dependencies` buys),
 * no sources, no tests, no docs and no external sourcemap. The engine bundles carry their maps
 * inline (R28), so this says nothing about `engine/*.map` — by design none exist.
 *
 * It reads the real archive rather than `vsce ls`, so it asserts what a user would actually
 * install. Skipped, with a message, when `pnpm package` has not been run in this tree: the `.vsix`
 * is a gitignored artifact and CI without a package step must not fail on its absence.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PACKAGE_DIR = path.resolve(__dirname, '../..');

function vsixPath(): string | null {
  const found = readdirSync(PACKAGE_DIR).filter((name) => name.endsWith('.vsix')).sort();
  return found.length === 0 ? null : path.join(PACKAGE_DIR, found[found.length - 1]);
}

const vsix = vsixPath();
const SKIP_REASON = `no .vsix in ${PACKAGE_DIR} — run \`pnpm package\` to produce one`;

/** The archive's own entry names, with the `extension/` prefix vsce adds stripped off. */
function entries(archive: string): string[] {
  const listing = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' });
  return listing
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .filter((line) => line.startsWith('extension/'))
    .map((line) => line.slice('extension/'.length));
}

describe.skipIf(vsix === null)('MG-C8: the packaged vsix', () => {
  it(`carries the engine and the compiled extension (${vsix === null ? SKIP_REASON : path.basename(vsix)})`, () => {
    const names = entries(vsix as string);
    expect(names).toContain('engine/engine.js');
    expect(names).toContain('engine/bridge.js');
    expect(names).toContain('out/extension.js');
  });

  it('carries no dependencies, no sources, no tests, no docs and no external sourcemap', () => {
    const names = entries(vsix as string);
    const forbidden = names.filter(
      (name) =>
        name.startsWith('node_modules/') ||
        name.startsWith('src/') ||
        name.startsWith('test/') ||
        name.startsWith('docs/') ||
        name.endsWith('.ts') ||
        (name.startsWith('out/') && name.endsWith('.map')),
    );
    expect(forbidden).toEqual([]);
  });
});

it.skipIf(vsix !== null)('skips MG-C8 when nothing has been packaged', () => {
  expect(SKIP_REASON).toContain('pnpm package');
});
