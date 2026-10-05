/**
 * 0c Task 6, fix I2 — the preflight's reason is a whole sentence (up to 300 chars). On the row
 * it is a pinned, `nowrap` cell, so uncapped it shoves the age, tier, size and CI off the line;
 * in the needs-you strip it was `flex: 0 0 auto`, so the item's own label shrank to nothing.
 * Both are capped with an ellipsis, and the full line stays readable in the Item tab (which
 * wraps) and in the cell's accessible name.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import itemsFixture from '../support/fixtures/items.json';
import { rowMetaCells } from '../../src/model/row-composition';
import type { ItemsResponse, WorkItem } from '../../src/model/work-items';

const css = fs.readFileSync(path.resolve(__dirname, '../../media/panel.css'), 'utf8');

/** The declarations of the FIRST rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (match === null) throw new Error(`no rule for ${selector}`);
  return match[1];
}

const JIRA = `Jira HB-627 could not be loaded (auth error) — fix access or choose Run anyway${'.'.repeat(200)}`;

function blockedItem(): WorkItem {
  const all = (JSON.parse(JSON.stringify(itemsFixture)) as ItemsResponse).items;
  const item = all.find((candidate) => candidate.id === 'pr:acme/web#102') as WorkItem;
  item.attention = { ...item.attention, reasons: ['needs_input'] as never };
  item.agents = [{ ...item.agents[0], phase: 'ready', needsYou: true, agentNote: JIRA }];
  return item;
}

describe('a long preflight reason never breaks the layout', () => {
  it('the blocked row cell has its own kind, and its accessible name is the whole note', () => {
    const cells = rowMetaCells(blockedItem(), 'parkingLot', {
      age: '2h', size: 'S', tier: 'S', activity: '', repo: 'web',
    }, Date.parse('2026-09-10T12:00:00.000Z'));
    const cell = cells.find((c) => c.kind === 'blocked');
    expect(cell?.text.endsWith(JIRA)).toBe(true);
    expect(cell?.label).toBe(JIRA);
    // The cells after it are still there to be laid out.
    expect(cells.map((c) => c.kind)).toEqual(expect.arrayContaining(['age', 'tier', 'size']));
  });

  it('waitingForReview (my open PR; e.g. a blocked respond run) shows the reason too', () => {
    const all = (JSON.parse(JSON.stringify(itemsFixture)) as ItemsResponse).items;
    const item = all.find((candidate) => candidate.id === 'pr:acme/web#200') as WorkItem;
    expect(item.lists).toContain('waitingForReview');
    item.attention = { ...item.attention, reasons: ['needs_input'] as never };
    item.agents = [
      { ...item.agents[0], running: false, needsYou: true, agentNote: JIRA, blockedStage: 'respond' },
    ];
    const cells = rowMetaCells(item, 'waitingForReview', {
      age: '2h', size: 'S', tier: 'S', activity: '', repo: 'web',
    }, Date.parse('2026-09-10T12:00:00.000Z'));
    const cell = cells.find((c) => c.kind === 'blocked');
    expect(cell?.label).toBe(JIRA);
    expect(cells.some((c) => /\bready\b|\bdone\b/.test(c.text))).toBe(false);
  });

  it('the blocked cell may shrink, and ellipsises', () => {
    const decl = rule('.row-signals > .cell.cell-blocked');
    expect(decl).toMatch(/min-width:\s*0/);
    expect(decl).toMatch(/overflow:\s*hidden/);
    expect(decl).toMatch(/text-overflow:\s*ellipsis/);
    expect(decl).toMatch(/white-space:\s*nowrap/);
    expect(decl).toMatch(/flex:\s*0 1 auto/);
    // Declared AFTER the pinned-cell rule of equal specificity, so it wins.
    expect(css.indexOf('.row-signals > .cell.cell-blocked')).toBeGreaterThan(
      css.indexOf('.row-signals > .cell:not(.cell-repo)'),
    );
  });

  it('the strip reason is capped and ellipsised, and the label keeps its share', () => {
    const reason = rule('.attention-reason');
    expect(reason).toMatch(/min-width:\s*0/);
    expect(reason).toMatch(/max-width:\s*50%/);
    expect(reason).toMatch(/overflow:\s*hidden/);
    expect(reason).toMatch(/text-overflow:\s*ellipsis/);
    expect(reason).toMatch(/white-space:\s*nowrap/);
    expect(reason).not.toMatch(/flex:\s*0 0 auto/);
    expect(rule('.attention-label')).toMatch(/flex:\s*1 1 auto/);
  });
});
