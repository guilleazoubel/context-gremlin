import { serve, realAdapters } from '../../host/serve';
import { loadCoreConfig } from '../../config/core-config';
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

  const handle = await serve(config, realAdapters(config), {
    log: (line) => io.stdout.write(`${line}\n`),
    verbose,
  });

  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
  // serve() already registered its own signal handlers that call close() —
  // this is a harmless no-op if that already ran; it exists so this command
  // never returns before shutdown has actually finished.
  await handle.close();
  return 0;
}
