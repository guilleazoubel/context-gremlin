import type { GitRunner } from '../git/git-runner';
import type { SessionFileSystem } from '../fs/session-file-system';

export function mirrorDirName(repoUrl: string): string {
  const slug = repoUrl
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/^git@/i, '')
    .replace(/[:/]/g, '-')
    .replace(/\.git$/i, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-');
  return `${slug}.git`;
}

export async function ensureMirror(
  git: GitRunner,
  fs: SessionFileSystem,
  mirrorsDir: string,
  repoUrl: string,
): Promise<string> {
  const mirrorPath = `${mirrorsDir}/${mirrorDirName(repoUrl)}`;
  const exists = await fs.exists(mirrorPath);
  if (!exists) {
    await fs.mkdir(mirrorsDir, { recursive: true });
    await git.run(['clone', '--mirror', repoUrl, mirrorPath], { cwd: mirrorsDir });
  } else {
    await git.run(['fetch', '--all', '--prune'], { cwd: mirrorPath });
  }
  return mirrorPath;
}
