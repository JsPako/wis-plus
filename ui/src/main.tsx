/**
 * WIS+ — entry point (Task 8).
 *
 * React Native (Web) runs inside the Tauri v2 webview; `react-native` is aliased
 * to `react-native-web` in vite.config.ts. The default RNW stylesheet injects
 * box-sizing / user-select rules the components rely on.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import defaults from 'react-native-web/dist/cjs/exports/defaults';
import { injectIntoGlobalCSS } from 'react-native-web';

import App from '@/App';

injectIntoGlobalCSS(defaults);

const container = document.getElementById('root');
if (!container) {
  throw new Error('WIS+: #root element missing in index.html');
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
