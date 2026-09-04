import { request } from '../client';
import { isSuccessStatus, printHttpError, runSocketCommand, type CommandIO } from '../command-io';
import type { Session } from '../../schema/session';

/** `cgremlin-core sessions [--json]` — lists every session (GET /sessions). */
export async function sessionsCommand(args: readonly string[], io: CommandIO): Promise<number> {
  return runSocketCommand(io, async (config) => {
    const res = await request(config.socketPath!, 'GET', '/sessions');
    if (!isSuccessStatus(res.status)) {
      return printHttpError(io, res.status, res.body);
    }
    if (args.includes('--json')) {
      io.stdout.write(`${JSON.stringify(res.body)}\n`);
      return 0;
    }
    const { sessions } = res.body as { sessions: Session[] };
    if (sessions.length === 0) {
      io.stdout.write('No sessions.\n');
      return 0;
    }
    for (const s of sessions) {
      io.stdout.write(`${s.id}  ${s.mode}  ${s.stageStatus}  lastRun=${s.lastRun?.outcome ?? 'none'}\n`);
    }
    return 0;
  });
}
