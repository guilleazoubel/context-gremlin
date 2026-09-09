import { request } from '../client';
import { isSuccessStatus, printHttpError, runSocketCommand, type CommandIO } from '../command-io';
import type { Inventory, InventoryEntry, InventoryGroups } from '../../inventory/inventory';

function flagsFor(entry: InventoryEntry): string {
  const flags: string[] = [];
  if (entry.isDraft) flags.push('draft');
  if (entry.ours.status !== 'none') {
    flags.push(entry.ours.phase);
    if (entry.ours.newCommits) flags.push('newCommits');
  }
  if (entry.teamActivity.length > 0) flags.push(`team:${entry.teamActivity.length}`);
  return flags.join(',');
}

function prNumber(entry: InventoryEntry, showRepo: boolean): string {
  if (!showRepo) return `#${entry.number}`;
  const repoName = entry.repo.slice(entry.repo.lastIndexOf('/') + 1);
  return `${repoName}#${entry.number}`;
}

function renderSection(title: string, entries: readonly InventoryEntry[], showRepo: boolean): string {
  if (entries.length === 0) return '';
  const rows = entries.map((e) => `  ${prNumber(e, showRepo)}  ${e.title}  ${e.author}  [${flagsFor(e)}]`);
  return [`${title} (${entries.length})`, ...rows].join('\n');
}

export function renderPrsTable(inventory: Inventory, groups: InventoryGroups): string {
  if (inventory.entries.length === 0) {
    return 'No PRs in the inventory.\n';
  }
  const showRepo = new Set(inventory.entries.map((e) => e.repo)).size > 1;
  const sections = [
    renderSection('UNREVIEWED', groups.unreviewed, showRepo),
    renderSection('TEAM ON IT', groups.teamOnIt, showRepo),
    renderSection('OURS', groups.ours, showRepo),
    renderSection('MINE', groups.mine, showRepo),
  ].filter((s) => s.length > 0);
  return `${sections.join('\n\n')}\n`;
}

/** `cgremlin-core prs [--json]` — the current PR inventory, grouped (GET /prs). */
export async function prsCommand(args: readonly string[], io: CommandIO): Promise<number> {
  return runSocketCommand(io, async (config) => {
    const res = await request(config.socketPath!, 'GET', '/prs');
    if (!isSuccessStatus(res.status)) {
      return printHttpError(io, res.status, res.body);
    }
    if (args.includes('--json')) {
      io.stdout.write(`${JSON.stringify(res.body)}\n`);
      return 0;
    }
    const { inventory, groups } = res.body as { inventory: Inventory; groups: InventoryGroups };
    io.stdout.write(renderPrsTable(inventory, groups));
    return 0;
  });
}
