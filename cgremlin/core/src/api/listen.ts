import { unlink } from 'node:fs/promises';
import type { Server } from 'node:http';

export async function listenOnSocket(server: Server, socketPath: string): Promise<void> {
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
}
