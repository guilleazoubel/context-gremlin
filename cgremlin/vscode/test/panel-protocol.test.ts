/**
 * R54 — the side panel's message protocol, the same discipline as R21's: two unions and one
 * parser that rejects anything it does not recognise.
 */
import { describe, expect, it } from 'vitest';
import { parsePanelMessage, type PanelToHost } from '../src/model/panel-protocol';

describe('R54 parsePanelMessage', () => {
  const accepted: PanelToHost[] = [
    { type: 'ready' },
    { type: 'selectRow', id: 'pr:acme/web#101', list: 'parkingLot' },
    { type: 'openItem', id: 'pr:acme/web#101' },
    { type: 'openChild', id: 'ticket:HB-627', childId: 'pr:acme/web#310' },
    { type: 'setSort', list: 'parkingLot', sort: 'smallestChange' },
    { type: 'toggleGroup', list: 'parkingLot', group: 'someoneOnIt', collapsed: false },
    { type: 'toggleRow', id: 'ticket:HB-627', expanded: true },
    { type: 'command', command: 'cgremlin.ack', id: 'pr:acme/web#101' },
    { type: 'command', command: 'cgremlin.openChildTarget', id: 'x', childId: 'pr:acme/web#310' },
  ];

  it('accepts every known shape, including ready', () => {
    for (const message of accepted) {
      expect(parsePanelMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
    }
  });

  it('rejects an unknown type, a missing field, a wrong type and prototype pollution', () => {
    const rejected: unknown[] = [
      { type: 'render' },
      { type: 'openItem' },
      { type: 'selectRow', id: 'pr:acme/web#101' },
      { type: 'selectRow', id: 'pr:acme/web#101', list: 'reviewing' },
      { type: 'selectRow', list: 'parkingLot' },
      { type: 'openItem', id: 42 },
      { type: 'openChild', id: 'x' },
      { type: 'setSort', list: 'reviewing', sort: 'oldest' },
      { type: 'setSort', list: 'parkingLot', sort: 'byVibes' },
      { type: 'setSort', list: 'investigations', sort: 'smallestChange' },
      { type: 'toggleGroup', list: 'parkingLot', group: 'nope', collapsed: true },
      { type: 'toggleGroup', list: 'parkingLot', group: 'someoneOnIt', collapsed: 'yes' },
      { type: 'command', command: 'cgremlin.ack' },
      JSON.parse('{"__proto__":{"polluted":true}}'),
      null,
      'ready',
      [],
    ];
    for (const message of rejected) expect(parsePanelMessage(message)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('only accepts a sort the list actually offers', () => {
    expect(parsePanelMessage({ type: 'setSort', list: 'myWork', sort: 'needsYouThenRecent' })).toEqual({
      type: 'setSort',
      list: 'myWork',
      sort: 'needsYouThenRecent',
    });
    expect(parsePanelMessage({ type: 'setSort', list: 'myWork', sort: 'untouchedFirstThenOldest' })).toBeNull();
  });
});
