/**
 * The one way out of the webview.
 *
 * `acquireVsCodeApi()` may be called exactly once per webview, and it is the entry module that
 * calls it. Every other module posts through here, which is also what lets a test drive a row's
 * buttons without installing the editor's own global.
 *
 * Runs in a browser context (R40).
 */

let sink: (message: unknown) => void = () => {};

export function setSink(next: (message: unknown) => void): void {
  sink = next;
}

export function post(message: unknown): void {
  sink(message);
}
