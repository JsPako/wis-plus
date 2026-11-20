/**
 * Minimal ambient types for the Tauri runtime injected into the webview.
 * Only the surface WIS+ actually calls is declared; keep it narrow so it
 * cannot drift from @tauri-apps/api silently.
 */
export {};

declare global {
  interface Window {
    __TAURI__?: {
      shell: {
        open(url: string): Promise<void>;
      };
    };
  }
}
