#!/usr/bin/env node
// A controllable stand-in for the real `claude` binary, used to test
// ClaudeCodeRunner's real subprocess spawning/parsing logic without
// making real, paid, network-dependent Claude API calls. Mirrors the
// exact NDJSON shapes verified against the real CLI (see the plan's
// "Verified Ground Truth" section).
'use strict';

const fs = require('node:fs');

const args = process.argv.slice(2);

function argValue(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

if (process.env.FAKE_CLI_ARGV_LOG) {
  fs.writeFileSync(process.env.FAKE_CLI_ARGV_LOG, JSON.stringify(args));
}

const prompt = args[args.indexOf('-p') + 1] ?? '';
const resumeId = argValue('--resume');
const sessionId = resumeId ? `resumed:${resumeId}` : 'fresh-session-1';

if (prompt === 'HANG_FOREVER') {
  // Never exits on its own; only terminated by a signal from the caller
  // under test, used to verify stop() actually kills the process.
  setInterval(() => {}, 1000);
} else if (prompt === 'READ_STDIN') {
  // Exits as soon as stdin is closed — proves the CLI is spawned with
  // stdin 'ignore' (not an open pipe); the Phase 2a hang regression check.
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
} else if (prompt === 'FAIL_LOUDLY') {
  process.stderr.write('simulated failure on stderr\n');
  process.exitCode = 1;
} else {
  process.stdout.write(
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: `echo: ${prompt}` }] },
    }) + '\n',
  );
  process.stdout.write(
    JSON.stringify({ type: 'result', session_id: sessionId, is_error: false }) + '\n',
  );
}
