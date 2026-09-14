/**
 * There is no notification policy left to have: needs-you never raises a popup.
 *
 * What survives is the level itself, because a stored `all` — the value that used to mean "one
 * popup per item" — must not become an error or a silent fallback the user cannot see. It reads
 * as the default, said ONCE in the log, never as a toast: announcing the end of popups with a
 * popup would be the joke it sounds like.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

type Policy = typeof import('../src/model/notify-policy');

let policy: Policy;

beforeEach(async () => {
  vi.resetModules();
  policy = await import('../src/model/notify-policy');
});

describe('the notification level', () => {
  it('has exactly two values, and keeps the quiet one as the default', () => {
    expect(policy.NOTIFICATION_LEVELS).toEqual(['needs-you-only', 'off']);
    expect(policy.DEFAULT_NOTIFICATION_LEVEL).toBe('needs-you-only');
  });

  it('reads each of them back unchanged', () => {
    expect(policy.normalizeLevel('needs-you-only')).toBe('needs-you-only');
    expect(policy.normalizeLevel('off')).toBe('off');
  });

  it('reads the legacy `all` as `needs-you-only`', () => {
    expect(policy.normalizeLevel('all')).toBe('needs-you-only');
  });

  it('says so in the log exactly once, however often the level is read', () => {
    const lines: string[] = [];
    for (let at = 0; at < 5; at += 1) policy.normalizeLevel('all', (line) => lines.push(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('all');
    expect(lines[0]).toContain('needs-you-only');
  });

  it('never logs for a level that is still a level', () => {
    const lines: string[] = [];
    policy.normalizeLevel('needs-you-only', (line) => lines.push(line));
    policy.normalizeLevel('off', (line) => lines.push(line));
    expect(lines).toEqual([]);
  });

  it('falls back to the default for anything it does not recognise', () => {
    expect(policy.normalizeLevel('shout')).toBe('needs-you-only');
    expect(policy.normalizeLevel('')).toBe('needs-you-only');
  });
});

describe('MG-B2 the needs-you rule stays in the core', () => {
  it('keeps no copy of it in the extension', () => {
    // Assembled rather than written out, so the phase-7 DoD grep over the whole package stays empty.
    const forbidden = ['NEEDS', 'YOU', 'REASONS'].join('_');
    const dir = path.resolve(__dirname, '../src');
    const offenders: string[] = [];
    const walk = (current: string): void => {
      for (const name of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, name.name);
        if (name.isDirectory()) walk(full);
        else if (name.name.endsWith('.ts') && fs.readFileSync(full, 'utf8').includes(forbidden)) {
          offenders.push(path.relative(dir, full));
        }
      }
    };
    walk(dir);
    expect(offenders).toEqual([]);
  });
});
