/**
 * useGlobalShortcuts — clean, cross-platform global keyboard listener for WIS+.
 *
 * Targets the two webviews the app ships in:
 *   • Windows  → Tauri v2 on WebView2
 *   • Arch     → Tauri v2 on WebKitGTK
 *
 * Both deliver DOM `keydown` events to the page's `window` as long as focus is
 * anywhere inside the webview (body, an input, a focused button), so we listen
 * on `window` rather than on any specific component. That makes the shortcuts
 * work "anywhere in the app" without focus juggling.
 *
 * Portability notes baked in below:
 *   • We match `event.code === 'Enter'` as well as `event.key === 'Enter'` —
 *     some WebKitGTK input methods (and numpad layouts on WebView2) report
 *     `key: 'Unidentified'` for the Enter key while `code` stays stable.
 *   • `metaKey` is accepted alongside `ctrlKey` so macOS dev builds behave
 *     identically; production targets never see a difference.
 *   • We only `preventDefault()` when a handler actually consumed the event,
 *     so an unbound shortcut can't swallow keys from focused inputs.
 */
import { useEffect, useRef } from 'react';

export interface GlobalShortcutHandlers {
  /** Ctrl+Enter (or Cmd+Enter on macOS) pressed anywhere in the app. */
  onCtrlEnter?: () => void;
  /** Escape key pressed anywhere in the app. */
  onEscape?: () => void;
}

/**
 * Register global keyboard shortcuts.
 *
 * Handlers are read through a ref, so callers can pass inline closures without
 * re-binding the window listener on every render (no stale-closure bugs, no
 * repeated add/remove churn in the webview).
 *
 * @param handlers Callbacks for the two WIS+ global shortcuts.
 * @param enabled  Set false to detach the listener entirely (e.g. during splash).
 */
export function useGlobalShortcuts(handlers: GlobalShortcutHandlers, enabled = true): void {
  const handlersRef = useRef<GlobalShortcutHandlers>(handlers);

  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      const h = handlersRef.current;

      // --- Ctrl+Enter: the WIS+ Spotlight trigger ----------------------------
      const isEnter = event.code === 'Enter' || event.key === 'Enter';
      if ((event.ctrlKey || event.metaKey) && !event.altKey && isEnter) {
        if (h.onCtrlEnter) {
          event.preventDefault(); // stop the webview's default (newline/submit)
          h.onCtrlEnter();
        }
        return;
      }

      // --- Escape: close top-most layer ---------------------------------------
      if (event.key === 'Escape' && h.onEscape) {
        // Deliberately no preventDefault: Escape has no harmful default in the
        // webviews, and leaving it un-prevented keeps any focused element's own
        // escape handling intact.
        h.onEscape();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
