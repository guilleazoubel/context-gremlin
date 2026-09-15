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
  // R55: the respond agent never posts to GitHub — no reply, no resolve, no
  // push of someone else's branch. It MAY commit locally and push its own
  // branch, which is where v1 ends.
  respond: {
    deny: [
      'Bash(gh pr review:*)',
      'Bash(gh pr comment:*)',
      'Bash(gh pr merge:*)',
      'Bash(gh pr close:*)',
      'Bash(gh pr edit:*)',
      'Bash(gh pr ready:*)',
      'Bash(gh api:*--method*)',
      'Bash(gh api:*graphql*)',
    ],
  },
  // R68/§9 — QA is review's deny list PLUS the verbs a verification agent
  // must never reach for. It uses the QA app as a normal user with the
  // configured TEST account, but it writes nothing outward: no PR, no issue,
  // no mutating API call. NOTE (stated plainly, per §9): this guard covers
  // `Bash(...)` only — an MCP server exposing a write tool is NOT blocked by
  // settings.local.json. The brief and the skill carry the prohibition for
  // everything the guard cannot reach.
  qa: {
    deny: [
      'Bash(gh pr review:*)',
      'Bash(gh pr comment:*)',
      'Bash(gh pr merge:*)',
      'Bash(gh pr close:*)',
      'Bash(gh pr edit:*)',
      'Bash(gh pr create:*)',
      'Bash(gh pr ready:*)',
      'Bash(gh issue:*)',
      'Bash(gh api:*--method*)',
      'Bash(gh api:*graphql*)',
      'Bash(git push:*)',
      'Bash(git commit:*)',
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
