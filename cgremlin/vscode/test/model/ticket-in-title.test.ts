/**
 * Round 3 §e.8 — the ticket key is a KEY, not 14 characters of conventional-commit prefix.
 *
 * The reported row read `feat(HB-1555): register signup-remove-la…` on a ~36-character budget:
 * two of the three components are chrome, and one of them is a ticket key the row has a FIELD
 * for. The item has no linked ticket, so `identityKeysOf` yielded `['#2140']` alone and `HB-1555`
 * survived only inside the prefix. The ellipsis was never a width problem.
 *
 * Both halves are guesses about text, so both are conservative: a key is lifted only from the
 * shapes the convention actually produces, and a prefix is stripped only where it is one.
 */
import { describe, expect, it } from 'vitest';
import { descriptionOf, identityKeysOf } from '../../src/model/row-composition';
import type { WorkItem } from '../../src/model/work-items';

function item(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'pr:aplaceformom/grace-frontend#2140',
    kind: 'pr',
    lists: ['waitingForReview'],
    title: 'feat(HB-1555): register signup-remove-lambda in the terraform stack',
    prs: [
      {
        repo: 'aplaceformom/grace-frontend',
        number: 2140,
        title: 'feat(HB-1555): register signup-remove-lambda in the terraform stack',
        branch: 'HB-1555-signup-remove-lambda',
      },
    ],
    ticket: null,
    agents: [],
    needsYou: false,
    attention: { reasons: [], since: '', acked: false, refs: [] },
    dismissed: false,
    dismissedAt: null,
    demoted: false,
    parkingLotGroup: null,
    ...over,
  } as unknown as WorkItem;
}

describe('the ticket key is lifted onto line one', () => {
  it('takes it out of the conventional-commit prefix when no ticket is linked', () => {
    expect(identityKeysOf(item())).toEqual(['HB-1555', '#2140']);
  });

  it('takes it off the branch when the title carries none', () => {
    const plain = item({ title: 'register signup-remove-lambda in the terraform stack' });
    expect(identityKeysOf(plain)).toEqual(['HB-1555', '#2140']);
  });

  it('prefers the LINKED ticket, and never guesses over it', () => {
    const linked = item({
      ticket: { key: 'HB-9', summary: 'x', status: 'In Review' } as WorkItem['ticket'],
    });
    expect(identityKeysOf(linked)).toEqual(['HB-9', '#2140']);
  });

  it('guesses nothing where there is no ticket-shaped key anywhere', () => {
    const none = item({
      title: 'fix: stop the retry loop',
      prs: [{ repo: 'a/b', number: 2140, title: 'fix: stop the retry loop', branch: 'retry-loop' }] as WorkItem['prs'],
    });
    expect(identityKeysOf(none)).toEqual(['#2140']);
  });
});

describe('the description is the human half of the subject', () => {
  it('strips the conventional-commit prefix', () => {
    expect(descriptionOf(item())).toBe('register signup-remove-lambda in the terraform stack');
  });

  it('strips a prefix with no scope too', () => {
    const plain = item({
      prs: [{ repo: 'a/b', number: 1, title: 'fix: stop the retry loop', branch: 'x' }] as WorkItem['prs'],
    });
    expect(descriptionOf(plain)).toBe('stop the retry loop');
  });

  it('leaves prose that merely contains a colon alone', () => {
    const prose = item({
      prs: [
        { repo: 'a/b', number: 1, title: 'Offer list: the second page is off by one', branch: 'x' },
      ] as WorkItem['prs'],
    });
    expect(descriptionOf(prose)).toBe('Offer list: the second page is off by one');
  });
});
