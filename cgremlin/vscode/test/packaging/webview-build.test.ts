/**
 * R40/R54 — the build step is wired, over BOTH entry points.
 *
 * Wiring `build:webview` into `build` only ships a `.vsix` with no script in it, and naming one
 * entry point ships an empty panel or an empty tab. Neither failure is visible at runtime: a
 * webview whose script is missing renders blank rather than throwing (Risk 19), so the wiring is
 * asserted here and the artifact itself is asserted in the `.vsix` (MG-B10).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
  dependencies?: Record<string, string>;
};

describe('R40 build:webview', () => {
  it('is referenced by both build and vscode:prepublish', () => {
    expect(manifest.scripts.build).toContain('build:webview');
    expect(manifest.scripts['vscode:prepublish']).toContain('build:webview');
  });

  it('names both entry points and both outputs', () => {
    const script = manifest.scripts['build:webview'];
    expect(script).toContain('src/webview/item-tab.ts');
    expect(script).toContain('media/item-tab.js');
    expect(script).toContain('src/webview/panel.ts');
    expect(script).toContain('media/panel.js');
    for (const flag of ['--bundle', '--format=iife', '--platform=browser', '--target=es2020']) {
      expect(script).toContain(flag);
    }
  });

  it('keeps esbuild and markdown-it as devDependencies, with zero runtime dependencies', () => {
    expect(Object.keys(manifest.devDependencies)).toEqual(
      expect.arrayContaining(['esbuild', 'markdown-it', '@types/markdown-it']),
    );
    expect(manifest.dependencies ?? {}).toEqual({});
  });

  it('gitignores both generated bundles and neither stylesheet', () => {
    const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    expect(ignore).toContain('media/item-tab.js');
    expect(ignore).toContain('media/panel.js');
    expect(ignore).not.toContain('media/item-tab.css');
    expect(ignore).not.toContain('media/panel.css');
  });
});
