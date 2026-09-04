import { describe, expect, it } from 'vitest';
import { extractTicketKey } from '../../src/gh/ticket-key';

describe('extractTicketKey', () => {
  it('extracts a ticket key from a feature branch name', () => {
    expect(extractTicketKey('feature/APP-123-fix')).toBe('APP-123');
  });

  it('returns null when the branch has no ticket key', () => {
    expect(extractTicketKey('fix/process-notification')).toBeNull();
  });

  it('returns null for a lowercase-prefixed key (legacy is case-sensitive on the project prefix)', () => {
    expect(extractTicketKey('app-12')).toBeNull();
  });
});
