/**
 * Phase 17 §3 / task 11, webview half — MG-17d, a `path:line` is an address you can open.
 *
 * The exactness is the guard: `fileRefOf` answers on a repo-relative `path:line` and on nothing
 * else, and a reference inside a fenced block is a code SAMPLE rather than an address, so it is
 * left as code.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { dom } from '../support/install-item-tab-dom';
import * as webview from '../../src/webview/item-tab';
import { partsOf } from '../../src/model/item-tab-parts';
import type { ItemTabState, TabAgent } from '../../src/model/item-tab-protocol';

const REVIEW = [
  '# Review',
  '',
  '### 1. Locale dropped',
  '- **Where:** `web-content.ts:88`',
  '',
  'Run `npm run build` first. The sample below is not an address:',
  '',
  '```',
  'src/other.ts:12',
  '```',
  '',
].join('\n');

function state(): ItemTabState {
  const agent = {
    sessionId: 's1',
    mode: 'review',
    phase: 'reviewing',
    running: false,
    needsYou: false,
    claimed: false,
    glyph: '',
    primaryArtifact: 'REVIEW.md',
    artifacts: [{ sessionId: 's1', name: 'REVIEW.md', mtime: 'm', text: REVIEW }],
  } as TabAgent;
  const built = {
    itemId: 'i',
    title: 't',
    needsYou: false,
    lists: [],
    chips: [],
    focus: { kind: 'agent', sessionId: 's1' },
    selectedSessionId: 's1',
    agents: [agent],
    prs: [],
    ticket: null,
    ticketError: null,
    buttons: [],
    parts: [],
  } as unknown as ItemTabState;
  built.parts = partsOf(built);
  built.focus = built.parts[0].focus;
  return built;
}

const body = () => dom.document.body.byClass('artifact-body')[0];

beforeEach(() => {
  dom.posted.length = 0;
});

describe('MG-17d file references become links', () => {
  it('turns a `path:line` in a Where line into a button carrying the same text', () => {
    webview.render(state());
    const refs = body().byClass('file-ref');
    expect(refs).toHaveLength(1);
    expect(refs[0].tagName).toBe('BUTTON');
    expect(refs[0].textContent).toBe('web-content.ts:88');
  });

  it('leaves a shell command and a fenced sample as CODE', () => {
    webview.render(state());
    const codes = body().findAll((el) => el.tagName === 'CODE');
    expect(codes.map((c) => c.textContent)).toContain('npm run build');
    const fenced = codes.find((c) => c.textContent.includes('src/other.ts:12'));
    expect(fenced?.parentNode?.tagName).toBe('PRE');
  });

  it('posts openFile with the path and the line on a click', () => {
    webview.render(state());
    body().byClass('file-ref')[0].emit('click');
    expect(dom.posted).toEqual([{ type: 'openFile', path: 'web-content.ts', line: 88 }]);
  });
});
