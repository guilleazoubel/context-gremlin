import { importLegacyConfig, resolveCoreConfig, writeCoreConfig } from '../../config/core-config';
import { configPathFor, type CommandIO } from '../command-io';

function legacyConfigPath(home: string): string {
  return `${home}/.cgremlin/config`;
}

async function importLegacyCommand(args: readonly string[], io: CommandIO): Promise<number> {
  const force = args.includes('--force');
  const legacyPath = legacyConfigPath(io.home);
  let legacyText: string;
  try {
    legacyText = await io.fs.readFile(legacyPath);
  } catch (err) {
    io.stderr.write(`Cannot read legacy config at '${legacyPath}': ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const outPath = configPathFor(io);
  let attachedTo: string | undefined;
  try {
    const partial = importLegacyConfig(legacyText);
    attachedTo = Object.keys(partial.environments)[0];
    const config = resolveCoreConfig(partial, io.home);
    await writeCoreConfig(io.fs, outPath, config, { force });
  } catch (err) {
    io.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  io.stdout.write(`Wrote ${outPath}\n`);
  if (attachedTo !== undefined) {
    io.stdout.write(`Attached the legacy local/Vercel environment settings to ${attachedTo}\n`);
  }
  return 0;
}

/** `cgremlin-core config <subcommand>` — currently only `import-legacy [--force]`. */
export async function configCommand(args: readonly string[], io: CommandIO): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === 'import-legacy') {
    return importLegacyCommand(rest, io);
  }
  io.stderr.write(`Unknown config subcommand: ${sub ?? '(none)'}\n`);
  return 2;
}
