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
  lock?: KeyedLock,
): DiscoveryHarness {
  const h = createHarness();
  // Share h's own lock by default — StageRunner/PipelineService (inside h)
  // and ReconciliationTick must use the SAME KeyedLock instance for the
  // per-session locking invariant (pipeline-service.ts) to actually
  // serialize anything between a tick and h.service's own calls.
  const sharedLock = lock ?? h.lock;
  const gh = new FakeGhRunner();
  const effectiveGh = wrapGh(gh);
  const config = discoveryConfig(configOverrides);
  const tick = new ReconciliationTick({
    gh: effectiveGh, store: h.store, pipeline: h.service, events: h.events, lock: sharedLock,
  });
  return { h, gh, tick, config, lock: sharedLock };
}
