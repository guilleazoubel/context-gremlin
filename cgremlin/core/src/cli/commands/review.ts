import { request } from '../client';
import { isSuccessStatus, loadConfigOrFail, printHttpError, type CommandIO } from '../command-io';
import { parsePrUrl } from '../../gh/pr-url';
import type { Session } from '../../schema/session';

/** `cgremlin-core review <pr-url>` — starts (or reports) a review for the given PR (POST /prs/:owner/:repo/:number/review). */
export async function reviewCommand(args: readonly string[], io: CommandIO): Promise<number> {
  const [prUrl] = args;
  if (!prUrl) {
    io.stderr.write('Usage: cgremlin-core review <pr-url>\n');
    return 2;
  }

  let ref;
  try {
    ref = parsePrUrl(prUrl);
  } catch (err) {
    io.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const config = await loadConfigOrFail(io);
  if (!config) return 1;

  const res = await request(config.socketPath!, 'POST', `/prs/${ref.owner}/${ref.repo}/${ref.number}/review`);
  if (!isSuccessStatus(res.status)) {
    return printHttpError(io, res.status, res.body);
  }
  const { session, created, started } = res.body as { session: Session; created: boolean; started: boolean };
  const verb = created ? 'Created and started' : started ? 'Started' : 'Already tracked (not started)';
  io.stdout.write(`${verb} review session ${session.id}\n`);
  return 0;
}
