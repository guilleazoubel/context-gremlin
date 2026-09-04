import { request } from '../client';
import { isSuccessStatus, loadConfigOrFail, printHttpError, type CommandIO } from '../command-io';
import type { ScanReport } from '../../inventory/inventory-scanner';

/** `cgremlin-core scan [--json]` — runs one inventory scan now (POST /prs/scan) and prints a summary. */
export async function scanCommand(args: readonly string[], io: CommandIO): Promise<number> {
  const config = await loadConfigOrFail(io);
  if (!config) return 1;

  const res = await request(config.socketPath!, 'POST', '/prs/scan');
  if (!isSuccessStatus(res.status)) {
    return printHttpError(io, res.status, res.body);
  }
  if (args.includes('--json')) {
    io.stdout.write(`${JSON.stringify(res.body)}\n`);
    return 0;
  }
  const report = res.body as ScanReport;
  io.stdout.write(
    `Scanned ${report.inventory.repos.length} repo(s): ${report.inventory.entries.length} PR(s), ` +
      `${report.inventory.errors.length} error(s); reconciliation: ${report.reconciliation.reconciled} reconciled, ` +
      `${report.reconciliation.actions.length} action(s), ${report.reconciliation.errors.length} error(s)\n`,
  );
  return 0;
}
