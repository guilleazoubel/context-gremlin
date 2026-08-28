import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/index';

describe('toolchain smoke test', () => {
  it('exposes a package version string', () => {
    expect(VERSION).toBe('0.0.1');
  });
});
