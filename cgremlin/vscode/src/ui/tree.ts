/**
 * One `TreeDataProvider` with four static roots, in `LIST_ORDER` order.
 *
 * One provider (rather than four) keeps a single `onDidChangeTreeData`, so an applied refresh is
 * exactly one fire no matter how many lists changed. Adding a fifth source stays what R18 promised:
 * one `LIST_ORDER` entry — this file does not enumerate the kinds.
 *
 * Takes its editor surface as a parameter (no `vscode` import).
 */
import { LIST_ORDER } from '../model/view-model';
import {
  troubleCommand,
  troubleMessage,
  troubleRowLabel,
  type EngineTrouble,
} from '../model/engine-trouble';
import type { ListItem, ListKind } from '../model/items';
import {
  COLLAPSIBLE_COLLAPSED,
  COLLAPSIBLE_EXPANDED,
  COLLAPSIBLE_NONE,
  type EventEmitterLike,
  type EventLike,
  type Host,
  type TreeDataProviderLike,
  type TreeItemLike,
} from './host';

export type TreeNode =
  | { kind: 'root'; list: ListKind; title: string; count: number }
  | { kind: 'row'; row: ListItem }
  /**
   * The engine on the socket is not one this extension can use. Four empty lists say nothing
   * about that, so while it holds, this single row replaces them and says what happened and
   * what to do — the whole point of the fix this node exists for.
   */
  | { kind: 'trouble'; trouble: EngineTrouble };

export class CgremlinTreeProvider implements TreeDataProviderLike<TreeNode> {
  private readonly emitter: EventEmitterLike<TreeNode | undefined>;
  private lists: Record<ListKind, ListItem[]> | null = null;
  private trouble: EngineTrouble | null = null;

  constructor(private readonly host: Host) {
    this.emitter = host.createEventEmitter<TreeNode | undefined>();
  }

  get onDidChangeTreeData(): EventLike<TreeNode | undefined> {
    return this.emitter.event;
  }

  /** Stores a new snapshot without announcing it — the caller decides when one fire happens. */
  setLists(lists: Record<ListKind, ListItem[]>): void {
    this.lists = lists;
  }

  /**
   * What the engine surface last said about an engine that cannot be used, or `null` when there
   * is nothing wrong. Like `setLists`, it stores without announcing: the caller fires.
   */
  setEngineTrouble(trouble: EngineTrouble | null): void {
    this.trouble = trouble;
  }

  /** Exactly one `onDidChangeTreeData` per applied refresh. */
  refresh(): void {
    this.emitter.fire(undefined);
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (element === undefined) {
      if (this.trouble !== null) return [{ kind: 'trouble', trouble: this.trouble }];
      return LIST_ORDER.map((descriptor) => ({
        kind: 'root' as const,
        list: descriptor.kind,
        title: descriptor.title,
        count: this.rowsOf(descriptor.kind).length,
      }));
    }
    if (element.kind === 'root') {
      return this.rowsOf(element.list).map((row) => ({ kind: 'row' as const, row }));
    }
    return [];
  }

  getTreeItem(element: TreeNode): TreeItemLike {
    if (element.kind === 'trouble') {
      const item = this.host.createTreeItem(troubleRowLabel(element.trouble), COLLAPSIBLE_NONE);
      item.id = 'engine:trouble';
      item.contextValue = `engine:${element.trouble.kind}`;
      item.tooltip = troubleMessage(element.trouble);
      item.command = {
        command: troubleCommand(element.trouble),
        title: 'cgremlin engine',
      };
      return item;
    }
    if (element.kind === 'root') {
      const item = this.host.createTreeItem(
        `${element.title} (${element.count})`,
        element.count === 0 ? COLLAPSIBLE_COLLAPSED : COLLAPSIBLE_EXPANDED,
      );
      item.id = `root:${element.list}`;
      item.contextValue = `root:${element.list}`;
      return item;
    }
    const { row } = element;
    const item = this.host.createTreeItem(
      `${row.indicator} ${row.label}`.trim(),
      COLLAPSIBLE_NONE,
    );
    item.id = `${row.kind}:${row.item.ref}`;
    item.description = row.description;
    item.tooltip = tooltipOf(row);
    item.contextValue = row.contextValue;
    item.command = { command: 'cgremlin.openItem', title: 'Open item', arguments: [element] };
    return item;
  }

  private rowsOf(kind: ListKind): ListItem[] {
    return this.lists?.[kind] ?? [];
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** The reasons live in the tooltip; the indicator lives in the label. */
function tooltipOf(row: ListItem): string {
  const reasons = row.item.attention.reasons;
  return [
    row.label,
    row.item.ref,
    reasons.length === 0 ? 'nothing pending' : reasons.join(', '),
    row.item.links.worktreePath,
  ]
    .filter((line): line is string => typeof line === 'string' && line !== '')
    .join('\n');
}
