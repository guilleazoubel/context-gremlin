/**
 * Round 3's acceptance criteria, as a checklist that fails the build.
 *
 * The per-defect tests live beside the modules they pin; this file is the list from the design
 * spec read back as assertions, so a future change cannot satisfy every unit test and still
 * undo the round.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { panelHarness, disposeHarnesses } from './support/panel-harness';
import { afterEach } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

afterEach(async () => {
  await disposeHarnesses();
});

describe('AC 2 — no gate is glued to a pipeline phase', () => {
  it('has no `needs you · ` anywhere under src', () => {
    const offenders = sources(path.join(ROOT, 'src')).filter((file) =>
      fs.readFileSync(file, 'utf8').includes('needs you · '),
    );
    expect(offenders).toEqual([]);
  });
});

describe('AC 4 — no button in the panel is labelled `Open`', () => {
  it('labels nothing exactly `Open`, on any row, in the notice, or in the trouble state', async () => {
    const h = await panelHarness();
    for (const row of h.rows()) h.toPanel({ type: 'toggleRow', id: row.id, expanded: true });
    h.toPanel({ type: 'toggleDetails', open: true });
    await h.settle();
    const state = h.state();
    const labels = [
      ...state.sections.flatMap((section) =>
        section.rows.flatMap((row) => [
          ...row.actions.map((action) => action.label),
          ...row.verbs.map((verb) => verb.label),
          ...row.parts.flatMap((part) => part.actions.map((action) => action.label)),
        ]),
      ),
      state.notice?.actionLabel ?? '',
      state.notice?.dismissLabel ?? '',
      state.trouble?.actionLabel ?? '',
    ];
    expect(labels).not.toContain('Open');
  });

  it('labels the workspace notice by what it opens, not by the act', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src/ui/panel-view.ts'), 'utf8');
    expect(source).not.toMatch(/OPEN_MANAGED_LABEL = 'Open';/);
    expect(source).toContain("OPEN_MANAGED_LABEL = 'Open the workspace'");
  });
});

describe('AC 6 — every sentence is a fact about the item or the label of a control', () => {
  it('draws no floating hint inside the expanded block', () => {
    const view = fs.readFileSync(path.join(ROOT, 'src/webview/panel/expanded.ts'), 'utf8');
    expect(view).not.toContain('expanded-hint');
    expect(fs.readFileSync(path.join(ROOT, 'media/panel.css'), 'utf8')).not.toContain(
      'expanded-hint',
    );
  });
});

describe('AC 7 — no tooltip, no emoji, no palette of our own', () => {
  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]|\u{FE0F}/u;

  it('assigns `title` nowhere under src/webview but the window title', () => {
    const offenders: string[] = [];
    for (const file of sources(path.join(ROOT, 'src/webview'))) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (line.includes('document.title')) continue;
        if (/\.title\s*=|setTitle/.test(line)) offenders.push(path.relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('ships no emoji in the panel`s own stylesheet or its expanded block', () => {
    for (const file of ['media/panel.css', 'src/webview/panel/expanded.ts']) {
      expect(EMOJI.test(fs.readFileSync(path.join(ROOT, file), 'utf8')), file).toBe(false);
    }
  });
});
