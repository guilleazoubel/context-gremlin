import { z } from 'zod';

export const DiscoveryConfigSchema = z.object({
  repos: z.array(z.string().regex(/^[^/\s]+\/[^/\s]+$/)).min(1),
  watchAuthors: z.array(z.string().min(1)),
  me: z.string().min(1),
  pollIntervalMs: z.number().int().positive().default(60_000),
  prListLimit: z.number().int().positive().max(100).default(50),
});
export type DiscoveryConfig = z.infer<typeof DiscoveryConfigSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

const CONFIG_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

export function parseLegacyWatchConfig(text: string): Pick<DiscoveryConfig, 'repos' | 'watchAuthors' | 'me'> {
  let repos: string[] | undefined;
  let watchAuthors: string[] | undefined;
  let me: string | undefined;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = CONFIG_LINE.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = unquote(rawValue);
    switch (key) {
      case 'WATCH_REPOS':
        repos = value.split(/\s+/).filter((s) => s.length > 0);
        break;
      case 'WATCH_AUTHORS':
        watchAuthors = value.split(/\s+/).filter((s) => s.length > 0);
        break;
      case 'GITHUB_ME':
        me = value;
        break;
      default:
        break;
    }
  }

  if (!repos || repos.length === 0) {
    throw new ConfigError('WATCH_REPOS is required in the legacy config');
  }
  if (!me) {
    throw new ConfigError('GITHUB_ME is required in the legacy config');
  }
  return { repos, watchAuthors: watchAuthors ?? [], me };
}
