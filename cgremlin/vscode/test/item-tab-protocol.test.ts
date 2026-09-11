/**
 * R21/R39 — the Item tab's message protocol is a pure, tested module, and the webview is
 * untrusted input like any other.
 */
import { describe, expect, it } from 'vitest';
import { parseWebviewMessage, type WebviewToHost } from '../src/model/item-tab-protocol';

describe('R21/R39 parseWebviewMessage', () => {
  const accepted: WebviewToHost[] = [
    { type: 'ready' },
    { type: 'selectAgent', sessionId: 'pr-acme-web-102' },
    { type: 'command', command: 'cgremlin.chat' },
    { type: 'command', command: 'cgremlin.startReview', arg: 'pr:acme/web#101' },
    { type: 'openLink', url: 'https://github.com/acme/web/pull/1' },
    { type: 'setFocus', focus: { kind: 'ticket' } },
    { type: 'setFocus', focus: { kind: 'agent', sessionId: 's1' } },
    { type: 'setFocus', focus: { kind: 'pr', repo: 'acme/web', number: 12 } },
  ];

  it('accepts every known shape, including ready (R39)', () => {
    for (const message of accepted) {
      expect(parseWebviewMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
    }
  });

  it('rejects an unknown type, a missing field, a wrong type and prototype pollution', () => {
    const rejected: unknown[] = [
      { type: 'nope' },
      { type: 'selectAgent' },
      { type: 'selectAgent', sessionId: 12 },
      { type: 'command' },
      { type: 'command', command: 12 },
      { type: 'openLink', url: '' },
      { type: 'setFocus', focus: { kind: 'pr', repo: 'acme/web', number: 'twelve' } },
      { type: 'setFocus', focus: { kind: 'agent' } },
      JSON.parse('{"__proto__":{"polluted":true}}'),
      JSON.parse('{"type":"ready","__proto__":{"polluted":true}}'),
      null,
      'ready',
      42,
      [],
    ];
    for (const message of rejected) expect(parseWebviewMessage(message)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('copies only the fields it recognises, so nothing extra crosses the boundary', () => {
    const parsed = parseWebviewMessage({
      type: 'selectAgent',
      sessionId: 's1',
      extra: 'ignored',
    });
    expect(parsed).toEqual({ type: 'selectAgent', sessionId: 's1' });
    expect(Object.keys(parsed as object)).toEqual(['type', 'sessionId']);
  });

  it('refuses a link that is not http(s)', () => {
    expect(parseWebviewMessage({ type: 'openLink', url: 'javascript:alert(1)' })).toBeNull();
    expect(parseWebviewMessage({ type: 'openLink', url: 'file:///etc/passwd' })).toBeNull();
  });
});
