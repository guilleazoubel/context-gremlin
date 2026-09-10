'use strict';
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');

const port = Number(process.env.FIXTURE_PORT);
const status = process.env.FIXTURE_STATUS ? Number(process.env.FIXTURE_STATUS) : 200;
const server = http.createServer((_req, res) => {
  res.writeHead(status);
  res.end('ok');
});
server.listen(port, () => {
  console.log(`fixture-server listening on ${port}`);
});

// A dev command that swallows SIGTERM: only SIGKILL gets the port back.
if (process.env.FIXTURE_TRAP_SIGTERM) {
  process.on('SIGTERM', () => {});
}

if (process.env.FIXTURE_SPAWN_CHILD) {
  const child = spawn('sleep', ['300'], { stdio: 'ignore' });
  if (process.env.FIXTURE_CHILD_PID_FILE) {
    fs.writeFileSync(process.env.FIXTURE_CHILD_PID_FILE, String(child.pid));
  }
}
