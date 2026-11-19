/**
 * Ambient type declarations for `react-native-web`.
 *
 * react-native-web 0.19.x ships no TypeScript definitions, so we declare the
 * surface of the module this codebase uses:
 *   - `injectIntoGlobalCSS`, called from main.tsx to inject theme CSS vars;
 *   - a re-export of `react-native` so RNW-compatible APIs type-check.
 */
declare module 'react-native-web' {
  /** Injects a CSS string into a <style> tag in the document head. */
  export function injectIntoGlobalCSS(cssText?: string): void;

  // Re-export everything from 'react-native' so React Native Web's
  // RN-compatible APIs type-check cleanly.
  export * from 'react-native';
}
