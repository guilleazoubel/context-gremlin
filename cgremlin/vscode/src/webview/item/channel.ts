/**
 * The one `acquireVsCodeApi()` call in the item bundle.
 *
 * The editor hands a webview its API object exactly once — a second call throws — so it is
 * acquired here and every module posts through this function. Runs in a browser context (R40).
 */
declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const api = acquireVsCodeApi();

export function post(message: unknown): void {
  api.postMessage(message);
}
