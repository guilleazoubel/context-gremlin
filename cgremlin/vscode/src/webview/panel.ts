/**
 * The side panel's webview entry (R54).
 *
 * The panel itself is a directory of small modules under `panel/`; this file exists because it is
 * the name esbuild bundles into `media/panel.js`, and because the handshake has to happen exactly
 * once, after the modules that answer it are loaded.
 *
 * It runs in a browser context, so it never imports the editor module (R40).
 */
import { connect } from './panel/index';

export { current, render } from './panel/index';

connect();
