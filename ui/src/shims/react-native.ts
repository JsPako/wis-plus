/**
 * Build-time shim: Vite aliases `react-native` → this file.
 * Re-exports react-native-web and stubs native-only APIs that
 * react-native-reanimated imports unconditionally.
 *
 * App source imports `'react-native'`; tsc resolves that to the real
 * package (which ships types). This file is only seen by Rollup.
 */
// @ts-nocheck — shim is consumed by Vite/Rollup, not type-checked in CI.
export * from 'react-native-web';

/** Native TurboModule bridge — no-op on web. */
export const TurboModuleRegistry = {
  get: (_name: string) => undefined,
};
