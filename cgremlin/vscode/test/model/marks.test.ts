/**
 * Review edit 6 — the marks are typographic, never emoji.
 *
 * Emoji size inconsistently in a sidebar, render in a colour the theme does not control, and drop
 * to a box on a machine whose emoji font is not installed — `font-src 'none'` (R38) means the
 * panel cannot ship one. A geometric mark at 11px is the same information at a stable size, in
 * the theme's own foreground.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { lifecycleSlots } from '../../src/model/lifecycle';
import { itemParts } from '../../src/model/item-parts';
import { itemActionFacts, rowActions } from '../../src/model/row-actions';
import type { ItemsResponse, WorkItem } from '../../src/model/work-items';
import itemsFixture from '../support/fixtures/items.json';

const modelDir = path.resolve(__dirname, '../../src/model');

function everyFileUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return everyFileUnder(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('no emoji under src/model', () => {
  it('carries no code point above U+2BFF anywhere, prose included', () => {
    const offenders: string[] = [];
    for (const file of everyFileUnder(modelDir)) {
      fs.readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, at) => {
          const found = [...line].filter((character) => (character.codePointAt(0) ?? 0) > 0x2bff);
          if (found.length > 0) {
            offenders.push(`${path.basename(file)}:${at + 1} ${found.join('')}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});

describe('the five part marks', () => {
  function partsOf(id: string, list: Parameters<typeof rowActions>[1]) {
    const response = JSON.parse(JSON.stringify(itemsFixture)) as ItemsResponse;
    const item = response.items.find((candidate) => candidate.id === id) as WorkItem;
    const facts = itemActionFacts(item);
    return itemParts({
      item,
      list,
      slots: lifecycleSlots({ agents: item.agents, facts, now: 0 }),
      actions: rowActions(facts, list),
      now: 0,
    });
  }

  it('gives each kind its own geometric mark', () => {
    const marks = new Map(
      [...partsOf('ticket:HB-627', 'myWork'), ...partsOf('pr:acme/web#101', 'parkingLot')].map(
        (part) => [part.kind, part.glyph],
      ),
    );
    expect([...marks]).toEqual([
      ['investigation', '∴'],
      ['development', '◆'],
      ['review', '◈'],
      ['ticket', '▣'],
      ['pr', '◇'],
    ]);
  });

  /**
   * Round 3 §e.5 — the marks are still the model's (the Item tab draws them), but the PANEL's
   * open block no longer has a glyph column at all. It was a 14px cost with no payoff and the
   * direct cause of the stranded lone mark, so it is gone from the stylesheet with the node.
   */
  it('draws no glyph column in the panel`s open block', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../../media/panel.css'), 'utf8');
    expect(css).not.toContain('.part-glyph');
  });
});
