#!/usr/bin/env node
// A controllable stand-in for the real `claude` binary, used to test
// ClaudeCodeRunner's real subprocess spawning/parsing logic without
// making real, paid, network-dependent Claude API calls. Mirrors the
// exact NDJSON shapes verified against the real CLI (see the plan's
// "Verified Ground Truth" section).
'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const args = process.argv.slice(2);

function argValue(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

if (process.env.FAKE_CLI_ARGV_LOG) {
  fs.writeFileSync(process.env.FAKE_CLI_ARGV_LOG, JSON.stringify(args));
  // Node has no process.getpgrp() — `ps` is the portable (POSIX) way to read
  // this process's own process group id, used by tests to prove the runner
  // spawned this CLI detached into its OWN group rather than the caller's.
  try {
    const pgid = execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)]).toString().trim();
    fs.writeFileSync(`${process.env.FAKE_CLI_ARGV_LOG}.pgrp`, pgid);
  } catch {
    // `ps` isn't available on every platform — best effort only.
  }
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
} else if (prompt === 'SPLIT_LINES') {
  // Writes one JSON line across two chunks with a delay between them (the
  // first chunk ends mid-JSON, so no newline has appeared yet), and never
  // terminates the line with '\n' at all — only the runner's close-time
  // "flush the trailing partial buffer" fallback ever delivers this line.
  const fullLine = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: `echo: ${prompt}` }] },
  });
  const mid = Math.floor(fullLine.length / 2);
  process.stdout.write(fullLine.slice(0, mid));
  setTimeout(() => {
    process.stdout.write(fullLine.slice(mid)); // still no trailing newline
  }, 20);
} else if (prompt === 'RESULT_ERROR') {
  // The shape the real CLI ends a failed turn with: the reason lives in the
  // `result` event, and nowhere else — nothing is written to stderr at all.
  process.stdout.write(
    JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
      session_id: sessionId,
    }) + '\n',
  );
  process.exitCode = 1;
} else if (prompt === 'TOOL_ACTIVITY') {
  // Defect 5 — replays REAL stream-json records (a live run's transcript, long strings
  // truncated) so the runner's forwarding is exercised against shapes nobody invented.
  const fixture = JSON.parse(
    fs.readFileSync(require('node:path').join(__dirname, 'claude-stream-json-tool-activity.json'), 'utf8'),
  );
  for (const record of fixture.records) {
    process.stdout.write(JSON.stringify(record) + '\n');
  }
  process.stdout.write(
    JSON.stringify({ type: 'result', session_id: sessionId, is_error: false }) + '\n',
  );
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
