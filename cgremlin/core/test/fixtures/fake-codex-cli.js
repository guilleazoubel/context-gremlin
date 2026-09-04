#!/usr/bin/env node
// A controllable stand-in for the real `codex` binary, used to test
// CodexRunner's real subprocess spawning/parsing logic without making
// real, paid, network-dependent Codex API calls. Mirrors the exact NDJSON
// shapes verified against the real CLI (see the plan's "Verified Ground
// Truth" section).
'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
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

// The prompt is always the last positional argument (both `exec …` and `exec resume <id> …`).
const prompt = args[args.length - 1] ?? '';
const resumeIdx = args.indexOf('resume');
const threadId = resumeIdx >= 0 ? args[resumeIdx + 1] : '01a06cfe-46c0-7800-99fa-83b3a2cbfc6b';

process.stderr.write('Reading additional input from stdin...\n');
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');

emit({ type: 'thread.started', thread_id: threadId });
if (prompt === 'HANG_FOREVER') {
  setInterval(() => {}, 1000);
} else if (prompt === 'READ_STDIN') {
  // Exits as soon as stdin is closed — proves the CLI is spawned with
  // stdin 'ignore' (not an open pipe); the Phase 2a hang regression check,
  // now pinned for adapter #2 too.
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
} else if (prompt === 'SPLIT_LINES') {
  // Writes one JSON line across two chunks with a delay between them (the
  // first chunk ends mid-JSON, so no newline has appeared yet), and never
  // terminates the line with '\n' at all — only the runner's close-time
  // "flush the trailing partial buffer" fallback ever delivers this line.
  const fullLine = JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: `echo: ${prompt}` } });
  const mid = Math.floor(fullLine.length / 2);
  process.stdout.write(fullLine.slice(0, mid));
  setTimeout(() => {
    process.stdout.write(fullLine.slice(mid)); // still no trailing newline
  }, 20);
} else if (prompt === 'FAIL_LOUDLY') {
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Model metadata for `x` not found. Defaulting to fallback metadata.' } });
  emit({ type: 'turn.started' });
  const inner = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: 'simulated failure' } });
  emit({ type: 'error', message: inner });
  emit({ type: 'turn.failed', error: { message: inner } });
  process.exitCode = 1;
} else {
  emit({ type: 'turn.started' });
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: `echo: ${prompt}` } });
  emit({ type: 'turn.completed', usage: { input_tokens: 12886, cached_input_tokens: 4480, cache_write_input_tokens: 0, output_tokens: 19, reasoning_output_tokens: 11 } });
}
