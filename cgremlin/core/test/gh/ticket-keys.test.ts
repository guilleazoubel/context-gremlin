import { describe, expect, it, vi } from 'vitest';
import { extractTicketKeys, resetTicketLinkingWarningForTests } from '../../src/gh/ticket-keys';
import { extractTicketKey } from '../../src/gh/ticket-key';

describe('extractTicketKeys (R4/R46, MG-11)', () => {
  it('extracts a key from a branch name, filtered to projectKeys', () => {
    expect(extractTicketKeys('feature/HB-627-thing', ['HB', 'GRAC'])).toEqual(['HB-627']);
  });

  it('keeps every distinct match, in order', () => {
    expect(extractTicketKeys('HB-627 and GRAC-12', ['HB', 'GRAC'])).toEqual(['HB-627', 'GRAC-12']);
  });

  it('dedupes repeated keys', () => {
    expect(extractTicketKeys('HB-627 fixes HB-627', ['HB'])).toEqual(['HB-627']);
  });

  it('drops UTF-8, SHA-256 and PR-123 even when projectKeys is set', () => {
    expect(extractTicketKeys('bump to SHA-256 / UTF-8 (PR-123)', ['HB', 'GRAC'])).toEqual([]);
  });

  it('R46: with projectKeys empty EVERY input returns [] — linking is disabled, not unfiltered', () => {
    resetTicketLinkingWarningForTests();
    expect(extractTicketKeys('feature/HB-627-thing', [])).toEqual([]);
    expect(extractTicketKeys('bump to SHA-256 / UTF-8 (PR-123)', [])).toEqual([]);
  });

  it('R46: the "linking disabled" line is logged once per process, not once per call', () => {
    resetTicketLinkingWarningForTests();
    const warn = vi.fn();
    extractTicketKeys('HB-627', [], { warn });
    extractTicketKeys('HB-628', [], { warn });
    extractTicketKeys('HB-629', [], { warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe('ticket linking disabled: set jira.projectKeys in core.json');
  });

  it('extractTicketKey is untouched and still returns only the first match', () => {
    expect(extractTicketKey('HB-627 and GRAC-12')).toBe('HB-627');
    expect(extractTicketKey('SHA-256')).toBe('SHA-256');
  });
});
