import { homedir } from 'node:os';
import { NodeFileSystem } from '../fs/node-file-system';
import type { CommandIO } from './command-io';
import { serveCommand } from './commands/serve';
import { prsCommand } from './commands/prs';
import { reviewCommand } from './commands/review';
import { sessionsCommand } from './commands/sessions';
import { scanCommand } from './commands/scan';
import { configCommand } from './commands/config';
import { localCommand } from './commands/local';

export const USAGE = `Usage: cgremlin-core <command> [options]

Commands:
  serve [--config path] [--verbose]   Run the engine host until a signal stops it
  prs [--json]                        Show the current PR inventory, grouped
  review <pr-url>                     Start (or report) a review for a PR
  sessions [--json]                   List all sessions
  scan [--json]                       Run one inventory scan now
  config import-legacy [--force]      Import ~/.cgremlin/config into core.json
  local start|stop|status [session]   Control the local dev app the engine owns
`;

type Command = (args: readonly string[], io: CommandIO) => Promise<number>;

const COMMANDS: Record<string, Command> = {
  serve: serveCommand,
  prs: prsCommand,
  review: reviewCommand,
  sessions: sessionsCommand,
  scan: scanCommand,
  config: configCommand,
  local: localCommand,
};

const CONFIG_FLAG_PREFIX = '--config=';

/** Extracts a shared `--config <path>` / `--config=<path>` flag out of argv, leaving the rest untouched for the command itself. */
function extractConfigFlag(args: readonly string[]): { configPath: string | undefined; rest: string[] } {
  const rest: string[] = [];
  let configPath: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--config') {
      configPath = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith(CONFIG_FLAG_PREFIX)) {
      configPath = arg.slice(CONFIG_FLAG_PREFIX.length);
      continue;
    }
    rest.push(arg);
  }
  return { configPath, rest };
}

/** Pure dispatcher: parses only the command name and the shared `--config` flag, hands the rest of argv to the command untouched. */
export async function main(argv: readonly string[], io: CommandIO): Promise<number> {
  const [command, ...rawRest] = argv;
  if (command === '--help' || command === '-h' || command === 'help') {
    io.stdout.write(USAGE);
    return 0;
  }
  const handler = command ? COMMANDS[command] : undefined;
  if (!handler) {
    io.stderr.write(USAGE);
    return 2;
  }
  const { configPath, rest } = extractConfigFlag(rawRest);
  const effectiveIo: CommandIO = configPath !== undefined ? { ...io, configPath } : io;
  return handler(rest, effectiveIo);
}

/** The real entry point — builds real io from the process and exits with the command's code. */
export async function run(): Promise<void> {
  const io: CommandIO = {
    stdout: process.stdout,
    stderr: process.stderr,
    home: homedir(),
    fs: new NodeFileSystem(),
  };
  try {
    process.exitCode = await main(process.argv.slice(2), io);
  } catch (err) {
    io.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
