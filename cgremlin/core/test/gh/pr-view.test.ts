import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ciStatus, CheckRunSchema, mapPrView, parsePrList, parsePrView, StatusCheckSchema,
} from '../../src/gh/pr-view';

const fixturesDir = path.join(__dirname, '../fixtures/gh');
function fixture(name: string): string {
  return readFileSync(path.join(fixturesDir, name), 'utf8');
}

type StatusCheck = z.infer<typeof StatusCheckSchema>;
type CheckRun = z.infer<typeof CheckRunSchema>;

function checkRun(overrides: Partial<CheckRun> = {}): StatusCheck {
  return {
    __typename: 'CheckRun',
    name: 'build',
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    ...overrides,
  };
}

function statusContext(state: string): StatusCheck {
  return { __typename: 'StatusContext', context: 'vercel', state };
}

describe('parsePrList', () => {
  const openListJson = fixture('pr-list-open.json');

  it('parses the real fixture into typed items with the observed reviewDecision values and boolean isDraft', () => {
    const items = parsePrList(openListJson);
    expect(items.length).toBe(4);
    expect(items.every((i) => typeof i.isDraft === 'boolean')).toBe(true);
    const decisions = new Set(items.map((i) => i.reviewDecision));
    expect(decisions).toEqual(new Set(['REVIEW_REQUIRED', 'CHANGES_REQUESTED']));
    const draft = items.find((i) => i.number === 2019);
    expect(draft?.isDraft).toBe(true);
  });

  it('empty stdout and an empty JSON array both parse to []', () => {
    expect(parsePrList('')).toEqual([]);
    expect(parsePrList('[]')).toEqual([]);
  });

  it('rejects an item whose headRefOid is not 40 hex', () => {
    const items = JSON.parse(openListJson);
    items[0].headRefOid = 'not-a-sha';
    expect(() => parsePrList(JSON.stringify(items))).toThrow();
  });

  it('rejects an item whose reviewDecision is an unknown string', () => {
    const items = JSON.parse(openListJson);
    items[0].reviewDecision = 'BOGUS_DECISION';
    expect(() => parsePrList(JSON.stringify(items))).toThrow();
  });
});

describe('parsePrView', () => {
  it('parses the merged fixture with state MERGED and a non-null mergedAt', () => {
    const view = parsePrView(fixture('pr-view-merged.json'));
    expect(view.state).toBe('MERGED');
    expect(view.mergedAt).not.toBeNull();
  });

  it('parses the open fixture with state OPEN and a null mergedAt', () => {
    const view = parsePrView(fixture('pr-view-open-approved.json'));
    expect(view.state).toBe('OPEN');
    expect(view.mergedAt).toBeNull();
  });

  it('parses statusCheckRollup: null as [] (gh emits null when the PR has no checks)', () => {
    const raw = JSON.parse(fixture('pr-view-open-approved.json'));
    raw.statusCheckRollup = null;
    const view = parsePrView(JSON.stringify(raw));
    expect(view.statusCheckRollup).toEqual([]);
  });
});

describe('ciStatus', () => {
  it('is none for an empty check list', () => {
    expect(ciStatus([])).toBe('none');
  });

  it('is success when all CheckRun conclusions and StatusContext states are benign (SUCCESS/SKIPPED/NEUTRAL)', () => {
    expect(
      ciStatus([checkRun({ conclusion: 'SUCCESS' }), checkRun({ conclusion: 'SKIPPED' }), checkRun({ conclusion: 'NEUTRAL' }), statusContext('SUCCESS')]),
    ).toBe('success');
  });

  it('is failure when any CheckRun conclusion is a failure conclusion', () => {
    expect(ciStatus([checkRun({ conclusion: 'SUCCESS' }), checkRun({ conclusion: 'FAILURE' })])).toBe('failure');
  });

  it('is pending when a CheckRun is not yet COMPLETED', () => {
    expect(ciStatus([checkRun({ status: 'IN_PROGRESS', conclusion: null })])).toBe('pending');
  });

  it('is pending when a StatusContext is PENDING', () => {
    expect(ciStatus([checkRun(), statusContext('PENDING')])).toBe('pending');
  });

  it('is failure when a StatusContext is ERROR', () => {
    expect(ciStatus([statusContext('ERROR')])).toBe('failure');
  });

  it('failure beats pending when both are present, regardless of order', () => {
    expect(ciStatus([checkRun({ status: 'IN_PROGRESS', conclusion: null }), checkRun({ conclusion: 'FAILURE' })])).toBe('failure');
    expect(ciStatus([checkRun({ conclusion: 'FAILURE' }), checkRun({ status: 'IN_PROGRESS', conclusion: null })])).toBe('failure');
  });
});

describe('mapPrView', () => {
  it('maps headRefOid to headSha, author.login to author, reviewedSha to null, and repo to the given slug', () => {
    const view = parsePrView(fixture('pr-view-open-approved.json'));
    const mapped = mapPrView('aplaceformom/grace-frontend', view);
    expect(mapped.pr).toEqual({
      repo: 'aplaceformom/grace-frontend',
      number: view.number,
      url: view.url,
      headSha: view.headRefOid,
      reviewedSha: null,
      title: view.title,
      author: view.author.login,
    });
    expect(mapped.state).toBe('OPEN');
    expect(mapped.isDraft).toBe(false);
    expect(mapped.reviewDecision).toBe('APPROVED');
  });
});
