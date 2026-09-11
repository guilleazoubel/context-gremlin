import { importLegacyConfig, resolveCoreConfig, writeCoreConfig } from '../../config/core-config';
import { configPathFor, type CommandIO } from '../command-io';
import { checkJiraCommand, type CheckJiraDeps } from './check-jira';

/** The legacy tool's config file — the one path that deliberately still points at `~/.cgremlin`. */
export function legacyConfigPath(home: string): string {
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

/** Reads `--me <login>` out of argv; `--me=<login>` is accepted too. */
function flagValue(args: readonly string[], name: string): string | undefined {
  const prefix = `${name}=`;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name) return args[i + 1];
    if (args[i].startsWith(prefix)) return args[i].slice(prefix.length);
  }
  return undefined;
}

/**
 * R4: `me` is never invented. It comes from `--me`, or — when the flag is
 * omitted — from the one authority that knows it, `gh api user --jq .login`.
 * No `gh`, no answer from `gh`, or an empty answer: the command writes
 * nothing and says which flag would fix it. An empty `me` would silently
 * defeat the own-PR refusal, so guessing is worse than failing.
 */
async function resolveMe(args: readonly string[], io: CommandIO): Promise<string | null> {
  const explicit = flagValue(args, '--me');
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim();
  if (io.gh !== undefined) {
    try {
      const { stdout } = await io.gh.run(['api', 'user', '--jq', '.login']);
      const login = stdout.trim();
      if (login !== '') return login;
    } catch {
      // Fall through to the same message an absent --me gets.
    }
  }
  return null;
}

async function initCommand(args: readonly string[], io: CommandIO): Promise<number> {
  const me = await resolveMe(args, io);
  if (me === null) {
    io.stderr.write('Cannot determine your GitHub login; pass --me <login> (gh api user --jq .login did not answer)\n');
    return 2;
  }
  const outPath = configPathFor(io);
  try {
    const config = resolveCoreConfig({ me, repos: [], runner: 'claude-code' }, io.home);
    await writeCoreConfig(io.fs, outPath, config, { force: args.includes('--force') });
  } catch (err) {
    io.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  io.stdout.write(`Wrote ${outPath}\n`);
  return 0;
}

/** `cgremlin-core config <subcommand>` — `init`, `import-legacy` and `check-jira`. */
export async function configCommand(
  args: readonly string[],
  io: CommandIO,
  deps: CheckJiraDeps = {},
): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === 'init') {
    return initCommand(rest, io);
  }
  if (sub === 'import-legacy') {
    return importLegacyCommand(rest, io);
  }
  if (sub === 'check-jira') {
    return checkJiraCommand(rest, io, deps);
  }
  io.stderr.write(`Unknown config subcommand: ${sub ?? '(none)'}\n`);
  return 2;
}
