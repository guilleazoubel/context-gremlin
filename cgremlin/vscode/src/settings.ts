/**
 * The extension's own settings. This is the only B1 module that touches the editor API, which is
 * why the purity guard (MG-B1) covers `core-client.ts`, `sse.ts` and `src/model/` and not this file.
 */
import os from 'node:os';
import * as vscode from 'vscode';

export type NotificationLevel = 'all' | 'needs-you-only' | 'off';

export interface Settings {
  socketPath: string;
  configPath: string;
  notificationLevel: NotificationLevel;
}

export const DEFAULT_SOCKET_PATH = '~/.cgremlin/engine.sock';
export const DEFAULT_CONFIG_PATH = '~/.cgremlin/core.json';

/** Expands a leading `~`, exactly as the core's own config loader does. */
export function expandHome(value: string, home: string = os.homedir()): string {
  if (value === '~') return home;
  if (value.startsWith('~/')) return `${home}${value.slice(1)}`;
  return value;
}

export function readSettings(): Settings {
  const cfg = vscode.workspace.getConfiguration('cgremlin');
  const level = cfg.get<string>('notificationLevel', 'all');
  return {
    socketPath: expandHome(cfg.get<string>('socketPath', DEFAULT_SOCKET_PATH)),
    configPath: expandHome(cfg.get<string>('configPath', DEFAULT_CONFIG_PATH)),
    notificationLevel: isLevel(level) ? level : 'all',
  };
}

function isLevel(value: string): value is NotificationLevel {
  return value === 'all' || value === 'needs-you-only' || value === 'off';
}
