'use strict';
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');

const port = Number(process.env.FIXTURE_PORT);
const server = http.createServer((_req, res) => {
  res.writeHead(200);
  res.end('ok');
});
server.listen(port, () => {
  console.log(`fixture-server listening on ${port}`);
});

if (process.env.FIXTURE_SPAWN_CHILD) {
  const child = spawn('sleep', ['300'], { stdio: 'ignore' });
  if (process.env.FIXTURE_CHILD_PID_FILE) {
    fs.writeFileSync(process.env.FIXTURE_CHILD_PID_FILE, String(child.pid));
  }
}
