/**
 * Round 3 §e.9 — the PR's people line stops telling the user what he himself did.
 *
 * `@guilleazoubel reviewed` on the user's own screen is noise: he knows. The useful fact is who
 * ELSE has been on the PR, and — when nobody has — that nobody has, which is a decision input
 * rather than an absence.
 *
 * Phase 11 §8(a) said "the panel never learns `me`". That is stale: `CoreConfigView.me` is on
 * `GET /config`, and `wiring.ts` already proves the thunk pattern that feeds config to the panel.
 */
import { describe, expect, it } from 'vitest';
import { peopleLine } from '../../src/model/row-composition';
import { meOf } from '../../src/model/items';
import type { WorkItemPr } from '../../src/model/work-items';

function pr(reviewedBy: string[], commentedBy: string[] = []): WorkItemPr {
  return {
    repo: 'aplaceformom/grace-frontend',
    number: 2140,
    url: 'https://example.invalid',
    humanActivity: { reviewedBy, commentedBy, lastAt: null },
  } as WorkItemPr;
}

describe('the people line is about everyone except me', () => {
  it('drops self and keeps the others', () => {
    expect(peopleLine(pr(['guilleazoubel', 'dtorres']), 'guilleazoubel')).toBe(
      '@dtorres reviewed',
    );
  });

  it('says nobody else has, rather than nothing at all, when I am the only one', () => {
    expect(peopleLine(pr(['guilleazoubel']), 'guilleazoubel')).toBe(
      'Nobody else has reviewed it yet',
    );
  });

  it('says the same on a PR nobody has touched', () => {
    expect(peopleLine(pr([]), 'guilleazoubel')).toBe('Nobody else has reviewed it yet');
  });

  it('drops self from the commenters too', () => {
    expect(peopleLine(pr([], ['guilleazoubel', 'jane']), 'guilleazoubel')).toBe(
      '@jane commented',
    );
  });

  it('keeps every login where the panel has not learned who I am', () => {
    expect(peopleLine(pr(['guilleazoubel']), '')).toBe('@guilleazoubel reviewed');
  });
});

describe('meOf reads the one field defensively, like every other config reader', () => {
  it('reads it off the resolved config', () => {
    expect(meOf({ me: 'guilleazoubel' } as never)).toBe('guilleazoubel');
  });

  it('is empty on an engine that sent none, rather than throwing', () => {
    expect(meOf(null)).toBe('');
    expect(meOf({} as never)).toBe('');
    expect(meOf({ me: 42 } as never)).toBe('');
  });
});
