/**
 * The engine's identity, as it appears on `GET /version` and in the
 * `engine.json` lock file. `ENGINE_VERSION` is a literal rather than an
 * import of `package.json`: `resolveJsonModule` is on, but `../package.json`
 * sits outside `rootDir: "src"`, so importing it would break emit. A test
 * pins the two together instead.
 */
export const ENGINE_NAME = 'cgremlin-core';
export const ENGINE_VERSION = '0.0.1';

/** What an engine that was never bundled reports: a checkout, `dist/`, a test. */
export const DEV_BUILD_ID = 'dev';

/**
 * Stamped into both bundles by `scripts/build-engine.mjs` — the same value in
 * `engine.js` and in `bridge.js`, so the extension can ask "is the engine
 * answering this socket the one I ship?" and get an answer the version string
 * cannot give. `ENGINE_VERSION` is the package's, and it stayed `0.0.1` across
 * two phases of engine changes: a same-version upgrade was invisible, and the
 * extension adopted a stale engine for as long as it kept running.
 */
declare const __CGREMLIN_BUILD_ID__: string | undefined;

export const ENGINE_BUILD_ID: string =
  typeof __CGREMLIN_BUILD_ID__ === 'string' ? __CGREMLIN_BUILD_ID__ : DEV_BUILD_ID;

/**
 * The ORDER the build id cannot carry. A content address answers "is this the engine I ship?"
 * and nothing else — two builds are equal or unequal, never older or newer. Two windows on
 * different builds therefore both read "unequal", both restarted the engine, and each restart
 * gave the other a brand-new identity to restart again: a SIGTERM every 1.5 s, for ever.
 *
 * `ENGINE_BUILD_TIME` is the ISO time `scripts/build-engine.mjs` stamped both bundles at, so the
 * two sides can be ordered: the newer one replaces the engine, the older one adopts it and asks
 * its window to reload. `null` for an engine that was never bundled (a checkout, `dist/`, a
 * test), which orders as "older than anything that has a time" — the safe direction, because a
 * side that cannot prove it is newer never signals.
 */
declare const __CGREMLIN_BUILD_TIME__: string | undefined;

export const ENGINE_BUILD_TIME: string | null =
  typeof __CGREMLIN_BUILD_TIME__ === 'string' ? __CGREMLIN_BUILD_TIME__ : null;
