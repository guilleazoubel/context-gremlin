import { describe, expect, it } from 'vitest';
import { defaultConfigPath } from '../../src/cli/command-io';
import { legacyConfigPath } from '../../src/cli/commands/config';

const HOME = '/Users/e2e';

describe('config path defaults (Phase 8 A1)', () => {
  // Asserted together on purpose: the two paths must never be "fixed"
  // in the same edit. The default config lives under the new state dir;
  // the legacy import still reads the old tool's file.
  it('defaults core.json under ~/.cgremlin-core while the legacy import still reads ~/.cgremlin/config', () => {
    expect(defaultConfigPath(HOME)).toBe(`${HOME}/.cgremlin-core/core.json`);
    expect(legacyConfigPath(HOME)).toBe(`${HOME}/.cgremlin/config`);
  });
});
