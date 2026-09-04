import { createHarness, type PipelineHarness } from './pipeline-harness';
import { FakeGhRunner } from './fake-gh-runner';
import { ReconciliationTick } from '../../src/discovery/reconciliation';
import type { DiscoveryConfig } from '../../src/discovery/discovery-config';
import type { GhRunner } from '../../src/gh/gh-runner';
import { KeyedLock } from '../../src/api/keyed-lock';

export function discoveryConfig(overrides: Partial<DiscoveryConfig> = {}): DiscoveryConfig {
  return {
    repos: ['acme/app'],
    watchAuthors: ['bob'],
    me: 'me-user',
    pollIntervalMs: 60_000,
    prListLimit: 50,
    ...overrides,
  };
}

export interface DiscoveryHarness {
  h: PipelineHarness;
  gh: FakeGhRunner;
  tick: ReconciliationTick;
  config: DiscoveryConfig;
  lock: KeyedLock;
}

export function createDiscoveryHarness(
  configOverrides: Partial<DiscoveryConfig> = {},
  wrapGh: (gh: FakeGhRunner) => GhRunner = (gh) => gh,
  lock: KeyedLock = new KeyedLock(),
): DiscoveryHarness {
  const h = createHarness();
  const gh = new FakeGhRunner();
  const effectiveGh = wrapGh(gh);
  const config = discoveryConfig(configOverrides);
  const tick = new ReconciliationTick({
    gh: effectiveGh, store: h.store, pipeline: h.service, events: h.events, lock,
  });
  return { h, gh, tick, config, lock };
}
