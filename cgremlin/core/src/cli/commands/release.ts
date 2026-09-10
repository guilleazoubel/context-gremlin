import { request } from '../client';
import { isSuccessStatus, printHttpError, runSocketCommand, type CommandIO } from '../command-io';
import type { Session } from '../../schema/session';

/**
 * `cgremlin-core release <session-id>` — R20's by-hand recovery path: drops a
 * human-turn claim (POST /sessions/:id/conversation/release) so a stuck claim
 * never needs `session.json` edited by hand.
 */
export async function releaseCommand(args: readonly string[], io: CommandIO): Promise<number> {
  const [sessionId] = args;
  if (!sessionId) {
    io.stderr.write('Usage: cgremlin-core release <session-id>\n');
    return 2;
  }
  return runSocketCommand(io, async (config) => {
    const res = await request(config.socketPath!, 'POST', `/sessions/${sessionId}/conversation/release`);
    if (!isSuccessStatus(res.status)) {
      return printHttpError(io, res.status, res.body);
    }
    const { session } = res.body as { session: Session };
    io.stdout.write(`Released the agent conversation for ${session.id}\n`);
    return 0;
  });
}
