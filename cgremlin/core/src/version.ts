/**
 * The engine's identity, as it appears on `GET /version` and in the
 * `engine.json` lock file. `ENGINE_VERSION` is a literal rather than an
 * import of `package.json`: `resolveJsonModule` is on, but `../package.json`
 * sits outside `rootDir: "src"`, so importing it would break emit. A test
 * pins the two together instead.
 */
export const ENGINE_NAME = 'cgremlin-core';
export const ENGINE_VERSION = '0.0.1';
