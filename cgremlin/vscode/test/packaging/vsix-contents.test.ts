/**
 * MG-C8 `vsix-is-self-contained-and-lean`.
 *
 * The packaged extension must carry the engine and nothing else: the two esbuild bundles and the
 * compiled extension, with no `node_modules/` symlink farm (that is what `--no-dependencies` buys),
 * no sources, no tests, no docs and no external sourcemap. The engine bundles carry their maps
 * inline (R28), so this says nothing about `engine/*.map` — by design none exist.
 *
 * **MG-B10 (Phase 9)**: it must also carry `media/item-tab.js`, `media/item-tab.css`,
 * `media/panel.js` and `media/panel.css`. The two `.js` files are **generated and gitignored**
 * (R40, R54), so their presence in the archive is the assertion that `vscode:prepublish` ran
 * `build:webview` over **both** entry points — wiring only `build`, or only one entry point,
 * ships a webview with no script, which renders blank rather than throwing. Deleting either
 * file before packaging must fail this test.
 *
 * It reads the real archive rather than `vsce ls`, so it asserts what a user would actually
 * install. Skipped, with a message, when `pnpm package` has not been run in this tree: the `.vsix`
 * is a gitignored artifact and CI without a package step must not fail on its absence.
 *
 * It reads a COPY, snapshotted once at collection time, rather than the archive in `PACKAGE_DIR`
 * directly: `pnpm package` can be re-running concurrently with `pnpm test` (nothing serializes
 * them), and `vsce package` rewrites the same filename in place — a test that opened that path
 * mid-rewrite could see a truncated or half-written zip. Copying it once, up front, into a temp
 * file means every `entries()` call below reads a file nothing else can be writing to.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PACKAGE_DIR = path.resolve(__dirname, '../..');

function vsixPath(): string | null {
  const found = readdirSync(PACKAGE_DIR).filter((name) => name.endsWith('.vsix')).sort();
  return found.length === 0 ? null : path.join(PACKAGE_DIR, found[found.length - 1]);
}

const discovered = vsixPath();
const SKIP_REASON = `no .vsix in ${PACKAGE_DIR} — run \`pnpm package\` to produce one`;

/**
 * `null` when nothing was found (the skip path). Otherwise a private, never-rewritten copy of
 * whatever `.vsix` existed at collection time — snapshotted before any test body runs.
 */
const vsix: string | null =
  discovered === null
    ? null
    : (() => {
        const dir = mkdtempSync(path.join(tmpdir(), 'cgvsc-vsix-'));
        const copy = path.join(dir, path.basename(discovered));
        copyFileSync(discovered, copy);
        return copy;
      })();

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

  it('MG-B10: carries both webview bundles and both stylesheets', () => {
    const names = entries(vsix as string);
    expect(names).toContain('media/item-tab.js');
    expect(names).toContain('media/item-tab.css');
    expect(names).toContain('media/panel.js');
    expect(names).toContain('media/panel.css');
  });

  /**
   * MG-B10 again, from the other side, so a THIRD entry point cannot be added to
   * `build:webview` and then quietly left out of the archive: every `media/*.js` that exists on
   * disk must be in the `.vsix`, and each must be a real bundle rather than an empty file.
   */
  it('MG-B10: every generated media bundle on disk made it into the archive', () => {
    const names = new Set(entries(vsix as string));
    const onDisk = readdirSync(path.join(PACKAGE_DIR, 'media')).filter((name) => name.endsWith('.js'));
    expect(onDisk.length).toBeGreaterThanOrEqual(2);
    for (const name of onDisk) {
      expect(names.has(`media/${name}`), `media/${name} is missing from the .vsix`).toBe(true);
      expect(statSync(path.join(PACKAGE_DIR, 'media', name)).size).toBeGreaterThan(1_000);
    }
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
