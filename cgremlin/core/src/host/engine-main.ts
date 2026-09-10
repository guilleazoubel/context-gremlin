/**
 * The bundle entry point: `node engine.js <command> …`.
 *
 * R24 — the engine scrubs the editor's own variables out of its `process.env`
 * before anything else happens, so every `bash -lc` it later spawns for an
 * agent inherits a clean environment even when the launcher's own
 * sanitization was bypassed (a hand-started `node engine.js`, a wrapper, a
 * future code path). Deleting `ELECTRON_RUN_AS_NODE` here is safe: Electron
 * reads it at process start, and by the time this line runs the process is
 * already a Node host.
 *
 * The CLI is loaded with a lazy `require` rather than a top-level `import`
 * precisely so the scrub really is first — a static import would be hoisted
 * above it.
 */
delete process.env.ELECTRON_RUN_AS_NODE;
delete process.env.NODE_OPTIONS;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('VSCODE_')) delete process.env[key];
}

if (process.env.CGREMLIN_ENGINE_PRINT_ENV === '1') {
  // The testable seam for R24 and R25: report what survived the scrub and
  // what Node host we are, then exit without starting an engine.
  process.stdout.write(
    `${JSON.stringify({
      electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
      nodeOptions: process.env.NODE_OPTIONS ?? null,
      vscodeKeys: Object.keys(process.env).filter((key) => key.startsWith('VSCODE_')),
      nodeVersion: process.version,
      electronVersion: process.versions.electron ?? null,
      path: process.env.PATH ?? null,
    })}\n`,
  );
  process.exit(0);
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { run } = require('../cli/main') as typeof import('../cli/main');

void run();
