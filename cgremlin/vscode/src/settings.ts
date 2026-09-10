/**
 * The extension's own settings. This is the only B1 module that touches the editor API, which is
 * why the purity guard (MG-B1) covers `core-client.ts`, `sse.ts`, `src/engine/` and `src/model/`
 * and not this file.
 *
 * There is exactly one path setting, and it names the engine's config file (D1). Every other path
 * — the socket, the log, the pid file, the session and worktree directories — is derived from that
 * file by the engine's own config loader, reached through `src/engine/bridge.ts` (MG-C6).
 */
import os from 'node:os';
import * as vscode from 'vscode';

export type NotificationLevel = 'all' | 'needs-you-only' | 'off';

export interface Settings {
  configPath: string;
  notificationLevel: NotificationLevel;
}

export const DEFAULT_CONFIG_PATH = '~/.cgremlin-core/core.json';

/**
 * Expands a leading `~`, exactly as the core's own config loader does. It survives here for the
 * one path the core cannot resolve for us: the setting itself, which is the loader's input.
 */
export function expandHome(value: string, home: string = os.homedir()): string {
  if (value === '~') return home;
  if (value.startsWith('~/')) return `${home}${value.slice(1)}`;
  return value;
}

export function readSettings(): Settings {
  const cfg = vscode.workspace.getConfiguration('cgremlin');
  const level = cfg.get<string>('notificationLevel', 'all');
  return {
    configPath: expandHome(cfg.get<string>('configPath', DEFAULT_CONFIG_PATH)),
    notificationLevel: isLevel(level) ? level : 'all',
  };
}

function isLevel(value: string): value is NotificationLevel {
  return value === 'all' || value === 'needs-you-only' || value === 'off';
}
