/**
 * Phase 11 task 1 — the panel stops explaining itself on hover.
 *
 * The user's first complaint was "on hover it shows the popup". Every one of those popups is a
 * DOM `title`, and a `title` is unreachable by keyboard, unreadable on a touchpad tap and
 * invisible to anybody scanning the list — so the strings it hid are either worth ink or worth
 * deleting. This guards the deletion: no module under `src/webview/panel/**` may assign `title`
 * at all, and the one signal that was hover-ONLY (CI) now says its state in text.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ciCell } from '../../src/model/work-items';

const webviewDir = path.resolve(__dirname, '../../src/webview');

function everyFileUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return everyFileUnder(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** `node.title = x`, `setTitle(...)`, `title:` on a cell — every way the popup could come back. */
const TITLE_WRITE = /\.title\s*=|setTitle|['"]title['"]\s*,/;

describe('tasks 1 and 8 — no tooltip anywhere in either bundle', () => {
  it('assigns no DOM title under src/webview, at any depth', () => {
    const offenders: string[] = [];
    for (const file of everyFileUnder(webviewDir)) {
      fs.readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, at) => {
          // `document.title` is the WINDOW title, not a tooltip, and stays (§3).
          if (line.includes('document.title')) return;
          if (TITLE_WRITE.test(line)) offenders.push(`${path.relative(webviewDir, file)}:${at + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });

  /**
   * MG-17f — phase 17 added a switcher, a verdict strip and a `file-ref` button, every one of
   * which is a control a tooltip would have been "cheap" on. The recursive scan above already
   * covers them; this pins that they are actually IN it, so deleting a module cannot quietly
   * shrink the guard.
   */
  it('covers every module phase 17 added under src/webview/item', () => {
    const covered = everyFileUnder(webviewDir).map((file) => path.relative(webviewDir, file));
    for (const name of [
      'item/tablist.ts',
      'item/verdict-strip.ts',
      'item/file-refs.ts',
      'item/artifact-pane.ts',
      'item/ticket-pane.ts',
    ]) {
      expect(covered).toContain(name);
    }
  });

  it('still sets the window title, which is not a tooltip', () => {
    const source = fs.readFileSync(path.join(webviewDir, 'item-tab.ts'), 'utf8');
    expect(source).toContain('document.title =');
  });
});

describe('task 1 — CI is readable without hovering', () => {
  it('says CI failing in words, with the bad tone and an accessible name', () => {
    expect(ciCell('failure')).toEqual({
      kind: 'ci',
      text: 'CI failing',
      tone: 'bad',
      label: 'CI failing',
    });
  });

  it('says CI pending in words', () => {
    expect(ciCell('pending')).toEqual({
      kind: 'ci',
      text: 'CI pending',
      tone: 'warn',
      label: 'CI pending',
    });
  });

  it('leaves a green dot wordless — a passing build is not news, but it still has a name', () => {
    expect(ciCell('success')).toEqual({ kind: 'ci', text: '', tone: 'good', label: 'CI passing' });
  });

  it('renders nothing at all where the engine reported no CI', () => {
    expect(ciCell('none')).toBeNull();
    expect(ciCell(null)).toBeNull();
  });

  it('carries no title field on any cell it builds', () => {
    expect(Object.keys(ciCell('failure') ?? {})).not.toContain('title');
  });
});
