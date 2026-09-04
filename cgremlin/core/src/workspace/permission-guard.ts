import type { SessionFileSystem } from '../fs/session-file-system';
import type { SessionMode } from '../schema/session-mode';

export interface PermissionConfig {
  allow?: string[];
  deny?: string[];
}

export const DEFAULT_PERMISSIONS: Record<SessionMode, PermissionConfig> = {
  investigation: {},
  development: {
    deny: [
      'Bash(gh pr review:*)',
      'Bash(gh pr comment:*)',
      'Bash(gh pr merge:*)',
      'Bash(gh pr close:*)',
    ],
  },
  review: {
    deny: [
      'Bash(gh pr review:*)',
      'Bash(gh pr comment:*)',
      'Bash(gh pr merge:*)',
      'Bash(gh pr close:*)',
      'Bash(gh pr edit:*)',
      'Bash(gh pr create:*)',
      'Bash(gh api:*--method*)',
      'Bash(git push:*)',
      'Bash(git commit:*)',
    ],
  },
};

export function renderPermissionSettings(config: PermissionConfig): string {
  const permissions: Record<string, string[]> = {};
  if (config.allow?.length) permissions.allow = config.allow;
  if (config.deny?.length) permissions.deny = config.deny;
  return JSON.stringify({ permissions }, null, 2);
}

export async function writePermissionSettings(
  fs: SessionFileSystem,
  worktreePath: string,
  mode: SessionMode,
): Promise<void> {
  const dir = `${worktreePath}/.claude`;
  await fs.mkdir(dir, { recursive: true });
  const content = renderPermissionSettings(DEFAULT_PERMISSIONS[mode]);
  await fs.writeFile(`${dir}/settings.local.json`, content);
}
