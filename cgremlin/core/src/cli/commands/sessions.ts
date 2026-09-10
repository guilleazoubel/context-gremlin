import { request } from '../client';
import { isSuccessStatus, printHttpError, runSocketCommand, type CommandIO } from '../command-io';
import type { Session } from '../../schema/session';
import { isClaimed } from '../../pipeline/pipeline-service';

/** `cgremlin-core sessions [--json]` — lists every session (GET /sessions). */
export async function sessionsCommand(args: readonly string[], io: CommandIO): Promise<number> {
  return runSocketCommand(io, async (config) => {
    const res = await request(config.socketPath!, 'GET', '/sessions');
    if (!isSuccessStatus(res.status)) {
      return printHttpError(io, res.status, res.body);
    }
    const { sessions } = res.body as { sessions: Session[] };
    // R20: whether a claim is live is decided by `isClaimed`, never by
    // `humanTurn !== null` — an expired claim reads as unclaimed here too.
    const now = new Date();
    if (args.includes('--json')) {
      const withClaimed = sessions.map((s) => ({ ...s, claimed: isClaimed(s, now) }));
      io.stdout.write(`${JSON.stringify({ ...(res.body as object), sessions: withClaimed })}\n`);
      return 0;
    }
    if (sessions.length === 0) {
      io.stdout.write('No sessions.\n');
      return 0;
    }
    for (const s of sessions) {
      io.stdout.write(
        `${s.id}  ${s.mode}  ${s.stageStatus}  lastRun=${s.lastRun?.outcome ?? 'none'}  claimed=${isClaimed(s, now)}\n`,
      );
    }
    return 0;
  });
}
