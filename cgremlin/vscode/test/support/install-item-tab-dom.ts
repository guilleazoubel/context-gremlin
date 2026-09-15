/**
 * Installs the fake DOM as a side effect of being imported.
 *
 * `src/webview/item-tab` calls `acquireVsCodeApi()` and posts `ready` while its module body runs,
 * so the globals must exist BEFORE it is imported. ESM evaluates imports in source order, so a
 * test imports this module first and the webview second — which is why this is a module rather
 * than a `beforeEach` (a hook runs after every import in the file).
 */
import { installDom, type InstalledDom } from './fake-dom';

export const dom: InstalledDom = installDom();
