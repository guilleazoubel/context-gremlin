/**
 * Phase 17 §7 / task 13 — the stylesheet, read as text.
 *
 * It is hand-written and committed, so it can be asserted on directly. Two things are being
 * pinned: the theme contract (every colour a `--vscode-*` token, no palette of our own, MG-17g's
 * sibling), and the reading measure — a 72ch column at 1.6, which is the difference between a
 * review you read and a review you scan.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const css = fs.readFileSync(path.resolve(__dirname, '../../media/item-tab.css'), 'utf8');

/** The declaration block of one selector, so a rule can be asserted on in isolation. */
function block(selector: string): string {
  const at = css.indexOf(`\n${selector}`);
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
  const open = css.indexOf('{', at);
  return css.slice(open + 1, css.indexOf('}', open));
}

describe('§7 colour is tokens only', () => {
  it('invents no palette — no hex, no rgb(), no hsl()', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\brgba?\(/);
    expect(css).not.toMatch(/\bhsla?\(/);
  });

  it('keeps `--vscode-charts-red` reserved for CI', () => {
    expect(css).not.toContain('--vscode-charts-red');
  });
});

describe('§7 the reading measure', () => {
  it('sets a 72ch column on the prose, and 1.6 on the body', () => {
    for (const selector of ['.artifact-body', '.ticket-description', '.ticket-comment']) {
      expect(css).toContain(selector);
    }
    expect(css).toMatch(/max-width:\s*72ch/);
    expect(block('body')).toMatch(/line-height:\s*1\.6/);
  });

  it('lets tables and code opt out of the measure and scroll instead', () => {
    expect(css).toMatch(/max-width:\s*none/);
    expect(css).toMatch(/overflow-x:\s*auto/);
  });
});

describe('§5b the code-block background applies to code, and only to code', () => {
  it('no longer paints the ticket description or a comment body', () => {
    // The old rule listed the prose containers themselves beside `.artifact-body pre`. Only real
    // fenced blocks may carry the code background now, so those two selectors are gone.
    const codeRule = css.slice(0, css.indexOf('--vscode-textCodeBlock-background'));
    const selectors = codeRule.slice(codeRule.lastIndexOf('\n\n'));
    expect(selectors).toContain('.artifact-body pre');
    expect(selectors).not.toContain('.ticket-description,');
    expect(selectors).not.toContain('.ticket-comment pre');
    // The containers keep the MEASURE and nothing else — that rule sets `max-width` only.
    expect(block('.artifact-body,\n.ticket-description,\n.ticket-comment')).toContain('72ch');
  });
});

describe('§2 the switcher is one scrollable line inside the sticky chrome', () => {
  it('never wraps and scrolls sideways', () => {
    const rule = block('.part-switcher');
    expect(rule).toMatch(/overflow-x:\s*auto/);
    expect(rule).toMatch(/flex-wrap:\s*nowrap|white-space:\s*nowrap/);
  });

  /**
   * The severe defect: the header and the switcher were BOTH `position: sticky; top: 0`, with the
   * header at the higher `z-index` — so the tablist was painted under the header and vanished the
   * moment you scrolled, taking the tab's only navigation with it. There is one sticky layer now,
   * and it holds the header, the action row and the tablist together.
   */
  it('has exactly one sticky layer, and it is the chrome', () => {
    expect(css.match(/position:\s*sticky/g)).toHaveLength(1);
    expect(block('.item-chrome')).toMatch(/position:\s*sticky/);
    expect(block('.item-chrome')).toMatch(/top:\s*0/);
    expect(block('.item-header')).not.toMatch(/position:\s*sticky/);
    expect(block('.part-switcher')).not.toMatch(/position:\s*sticky/);
  });

  it('marks the selected tab with a 2px focusBorder rule', () => {
    expect(block('.part-tab.selected')).toContain('--vscode-focusBorder');
  });
});

describe('§3 a file reference reads as an address, not as a box', () => {
  it('is a borderless link-coloured button with a visible focus ring', () => {
    const rule = block('.file-ref');
    expect(rule).toContain('--vscode-textLink-foreground');
    expect(rule).toMatch(/border:\s*none/);
    expect(rule).not.toContain('background: var(--vscode-textCodeBlock-background)');
    expect(css).toMatch(/\.file-ref:focus-visible[^{]*\{[^}]*--vscode-focusBorder/);
  });
});

describe('§3 the verdict strip carries its tone', () => {
  it('gives each tone a token and mixes the background off it', () => {
    expect(css).toContain('--vscode-testing-iconPassed');
    expect(css).toContain('--vscode-errorForeground');
    expect(css).toContain('--vscode-notificationsWarningIcon-foreground');
    expect(css).toMatch(/color-mix\(in srgb, var\(--verdict-tone\) 10%, transparent\)/);
  });
});
