/**
 * WIS+ — entry point.
 *
 * React Native (Web) runs inside the Tauri v2 webview; `react-native` is aliased
 * to `react-native-web` in vite.config.ts.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';

import './global.css';
import App from '@/App';

const container = document.getElementById('root');
if (!container) {
  throw new Error('WIS+: #root element missing in index.html');
}

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
