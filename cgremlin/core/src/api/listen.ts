import { chmod, unlink } from 'node:fs/promises';
import net from 'node:net';
import type { Server } from 'node:http';

export class SocketInUseError extends Error {
  /** `detail` appends a parenthesised explanation — e.g. which lock file named the owner we could not identify. */
  constructor(socketPath: string, detail?: string) {
    super(`Another process is already listening on '${socketPath}'${detail === undefined ? '' : ` (${detail})`}`);
    this.name = 'SocketInUseError';
  }
}

/** True when something is accepting connections on `socketPath` right now. Also the lock's "is the recorded owner still serving?" probe (R22). */
export function isSocketLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = net.createConnection(socketPath);
    client.once('connect', () => {
      client.destroy();
      resolve(true);
    });
    client.once('error', () => {
      resolve(false);
    });
  });
}

export async function listenOnSocket(server: Server, socketPath: string): Promise<void> {
  const live = await isSocketLive(socketPath);
  if (live) {
    throw new SocketInUseError(socketPath);
  }
  await unlink(socketPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600);
}
