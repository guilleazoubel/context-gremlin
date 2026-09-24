/**
 * "the sections and items all have the same backgrounds and its hard to differentiate."
 *
 * He is right about the ground. §5 gave each section a colour, but it only ever reached a 3 px
 * rule, a glyph and a count badge — the header, the rows and the sidebar behind them were one
 * flat field, so seven sections and thirty rows read as one wall.
 *
 * Two surfaces answer it, and they are surfaces rather than more hue: the header becomes a BAND
 * (its section's colour tinted into the editor's own header ground), and a row becomes a raised
 * CARD on that ground, so §7's 4 px gap between rows is a gap between objects rather than a gap
 * in text. Everything is still a `--vscode-*` token mixed with another, which is what makes it
 * hold in a light theme and a dark one: there is no fixed value in the file to drift.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PANEL_SECTIONS, sectionClassOf } from '../../src/model/work-items';

const css = fs.readFileSync(path.resolve(__dirname, '../../media/panel.css'), 'utf8');

/** The value of one custom property, with comments and newlines already gone. */
function declared(name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(css);
  if (match === null) throw new Error(`no declaration of ${name}`);
  return match[1].replace(/\s+/g, ' ').trim();
}

describe('every section is told apart from the one above and below it', () => {
  it('declares a colour of its own and binds it to its class', () => {
    for (const section of PANEL_SECTIONS) {
      const token = `--cg-sec-${section.key.replace(':', '-')}`;
      expect(declared(token)).not.toBe('');
      expect(css).toMatch(
        new RegExp(`\\.${sectionClassOf(section.key)}\\s*\\{[^}]*--cg-section:\\s*var\\(${token}\\)`),
      );
    }
  });

  it('never repeats a neighbour, so two touching headers can never read as one', () => {
    const values = PANEL_SECTIONS.map((s) => declared(`--cg-sec-${s.key.replace(':', '-')}`));
    for (let i = 1; i < values.length; i += 1) expect(values[i]).not.toBe(values[i - 1]);
    expect(new Set(values).size).toBe(values.length);
  });

  it('holds in BOTH themes because nothing in the file is a fixed colour', () => {
    const colours = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g);
    expect(colours).toBeNull();
    // Either straight off a `--vscode-*` token or through the one fallback that is itself one.
    expect(declared('--cg-chart-fallback')).toContain('var(--vscode-');
    for (const section of PANEL_SECTIONS) {
      const value = declared(`--cg-sec-${section.key.replace(':', '-')}`);
      expect(value.includes('var(--vscode-') || value.includes('var(--cg-chart-fallback)')).toBe(true);
    }
  });
});

describe('a section reads as a band, and a row as an object on it', () => {
  it('tints the sticky header bar with the colour of the section under it', () => {
    expect(css).toMatch(/\.section-bar\s*\{[^}]*background:\s*color-mix\([^;]*var\(--cg-section/);
  });

  it('raises a row off the sidebar ground, so the 4 px gap separates two objects', () => {
    expect(css).toMatch(/\.row\s*\{[^}]*background:\s*var\(--cg-row\)/);
    expect(declared('--cg-row')).toContain('color-mix(');
  });

  it('keeps hover and selection ABOVE the resting card rather than equal to it', () => {
    const resting = declared('--cg-row');
    expect(resting).not.toBe('var(--vscode-list-hoverBackground)');
    expect(resting).not.toBe('var(--vscode-list-inactiveSelectionBackground)');
    expect(css).toMatch(/\.row:hover\s*\{[^}]*background:\s*var\(--vscode-list-hoverBackground\)/);
    expect(css).toMatch(/\.row\.selected\s*\{[^}]*background:\s*var\(--vscode-list-inactiveSelectionBackground\)/);
  });
});
