import path from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * WIS+ — React Native (Web) running inside a Tauri v2 webview.
 *
 * - `react-native` resolves to `react-native-web` so every RN component in
 *   `src/` is plain, portable React Native code.
 * - `react-native-reanimated` needs **no** babel/vite plugin on Web — its
 *   Web runtime works out of the box (the plugin is only for native builds).
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // Exact-match: `import ... from 'react-native'` → our shim (RNW + native stubs).
      { find: /^react-native$/, replacement: path.resolve(__dirname, 'src/shims/react-native.ts') },
      { find: '@', replacement: path.resolve(__dirname, 'src') },
    ],
  },
  optimizeDeps: {
    include: ['react-native-web'],
  },
  server: {
    // Tauri v2 devUrl — keep in sync with src-tauri/tauri.conf.json.
    port: 1420,
    strictPort: true,
  },
  clearScreen: false,
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: false,
  },
});
