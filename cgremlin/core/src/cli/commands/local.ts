import { request } from '../client';
import { isSuccessStatus, printHttpError, runSocketCommand, type CommandIO } from '../command-io';
import type { LocalAppStatus } from '../../env/environment-service';

export const LOCAL_USAGE = 'Usage: cgremlin-core local start <session-id> | stop [session-id] | status [session-id] [--json]\n';

/** The one-line human form of a status: `stopped`, `running <session> <url> pid <pid>`, or `unavailable — <reason>`. */
export function formatLocalStatus(status: LocalAppStatus): string {
  if (status.state === 'running') {
    return `running ${status.sessionId ?? '?'} ${status.url ?? '?'} pid ${status.pid ?? '?'}`;
  }
  if (status.state === 'unavailable') {
    return `unavailable — ${status.reason ?? 'no reason given'}`;
  }
  return 'stopped';
}

function pathFor(sub: 'start' | 'stop' | 'status', id: string | undefined, fresh: boolean): string {
  if (sub === 'status') return id === undefined ? '/local' : `/sessions/${id}/local`;
  if (sub === 'stop') return id === undefined ? '/local/stop' : `/sessions/${id}/local/stop`;
  return `/sessions/${id}/local/start${fresh ? '?fresh=1' : ''}`;
}

/**
 * `cgremlin-core local start|stop|status [session-id]` — the local dev app the
 * engine owns. `stop`/`status` with no session id address whichever session
 * currently owns the app; `start` always names one.
 */
export async function localCommand(args: readonly string[], io: CommandIO): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== 'start' && sub !== 'stop' && sub !== 'status') {
    io.stderr.write(`Unknown local subcommand: ${sub ?? '(none)'}\n${LOCAL_USAGE}`);
    return 2;
  }
  const json = rest.includes('--json');
  const fresh = rest.includes('--fresh');
  const sessionId = rest.find((a) => !a.startsWith('--'));
  if (sub === 'start' && sessionId === undefined) {
    io.stderr.write(`local start <session-id> requires a session id\n${LOCAL_USAGE}`);
    return 2;
  }

  return runSocketCommand(io, async (config) => {
    const method = sub === 'status' ? 'GET' : 'POST';
    const res = await request(config.socketPath!, method, pathFor(sub, sessionId, fresh));
    if (!isSuccessStatus(res.status)) {
      return printHttpError(io, res.status, res.body);
    }
    const { status } = res.body as { status: LocalAppStatus };
    io.stdout.write(json ? `${JSON.stringify(status)}\n` : `${formatLocalStatus(status)}\n`);
    return 0;
  });
}
