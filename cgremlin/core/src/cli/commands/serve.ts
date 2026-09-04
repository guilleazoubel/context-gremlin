import { serve, realAdapters } from '../../host/serve';
import { loadCoreConfig } from '../../config/core-config';
import { SocketInUseError } from '../../api/listen';
import { configPathFor, type CommandIO } from '../command-io';

/** `cgremlin-core serve [--config path] [--verbose]` — loads config, wires the real engine, and waits until a signal closes it. */
export async function serveCommand(args: readonly string[], io: CommandIO): Promise<number> {
  const verbose = args.includes('--verbose');
  let config;
  try {
    config = await loadCoreConfig(io.fs, configPathFor(io), io.home);
  } catch (err) {
    io.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  let handle;
  try {
    handle = await serve(config, realAdapters(config), {
      // Engine event/lifecycle logs are diagnostics, not command output —
      // they must go to stderr so `cgremlin-core serve > out.log` doesn't
      // capture them as if they were the command's actual result.
      log: (line) => io.stderr.write(`${line}\n`),
      verbose,
    });
  } catch (err) {
    if (err instanceof SocketInUseError) {
      io.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }

  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
  try {
    // Memoized in serve() — a harmless no-op if its own internal signal
    // handler already triggered (and possibly finished) this same close.
    await handle.close();
    return 0;
  } catch (err) {
    io.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
