/**
 * WIS+ design tokens — live theme bridge (Task 7.5).
 *
 * Every color is a CSS custom property written onto <html> by the Theme
 * Engine (`theme/ThemeContext.tsx`) at boot and on every theme switch, with
 * Workshop Dark hex values as fallbacks — so this file remains the static
 * default export even before the provider mounts.
 *
 * A high-contrast garage palette: deep matte charcoal surfaces, one loud
 * accent (Mercedes signal amber) for actions and the brand "+", plus clear
 * verify-green / danger-red status colors. Every screen in the app must pull
 * from these tokens — no raw hex values in components.
 */

export const colors = {
  // Core surfaces -----------------------------------------------------------
  bgPrimary: 'var(--wis-bg-primary, #121417)',       // app background
  bgSurface: 'var(--wis-bg-surface, #1B1F24)',       // cards, panels, modal bodies
  bgElevated: 'var(--wis-bg-elevated, #242930)',     // selected rows, chips, hover surfaces
  borderSubtle: 'var(--wis-border-subtle, #2E343C)', // card outlines, dividers

  // Accents & status ---------------------------------------------------------
  accentPrimary: 'var(--wis-accent-primary, #E5A93C)',   // primary action + brand "+"
  accentSecondary: 'var(--wis-accent-secondary, #8FB6D9)',
  /** Back-compat alias for pre-7.5 components — same var as accentPrimary. */
  accentAmber: 'var(--wis-accent-primary, #E5A93C)',
  verifyGreen: 'var(--wis-verify-green, #2EA043)',   // "verified against the original scan"
  dangerRed: 'var(--wis-danger-red, #DA3633)',       // errors, unverified / misread values

  // Text ----------------------------------------------------------------------
  textPrimary: 'var(--wis-text-primary, #F0F3F6)',   // metallic white
  textSecondary: 'var(--wis-text-secondary, #9BA3AF)', // muted labels, hints
  textMuted: 'var(--wis-text-muted, #5F6771)',

  // Derived (kept here so components never invent new hex) --------------------
  /** Text on accent buttons — computed from the active theme's accent. */
  textOnAmber: 'var(--wis-text-on-accent, #121417)',
  hairline: 'var(--wis-hairline, rgba(240, 243, 246, 0.08))',
  hairlineStrong: 'var(--wis-hairline-strong, rgba(240, 243, 246, 0.16))',
  scrim: 'var(--wis-scrim, rgba(9, 10, 12, 0.62))',
  amberDim: 'var(--wis-accent-dim, rgba(229, 169, 60, 0.14))',
  /** Back-compat alias for pre-7.5 components — same var as hairline. */
  borderHairline: 'var(--wis-hairline, rgba(240, 243, 246, 0.08))',
  /** Back-compat alias for pre-7.5 components — same var as amberDim. */
  accentDim: 'var(--wis-amber-dim, rgba(229, 169, 60, 0.16))',
  /** Shadow fill for elevated cards (Spotlight panel, modals). */
  shadow: 'var(--wis-shadow, rgba(0, 0, 0, 0.5))',
} as const;

export type ColorToken = keyof typeof colors;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  pill: 999,
} as const;

export const typography = {
  brand: { fontSize: 28, fontWeight: '800' as const, letterSpacing: 2 },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '700' as const,
    letterSpacing: 1.6,
    textTransform: 'uppercase' as const,
  },
  body: { fontSize: 15, fontWeight: '400' as const, lineHeight: 22 },
  rowLabel: { fontSize: 15, fontWeight: '600' as const },
  caption: { fontSize: 13, fontWeight: '400' as const, lineHeight: 18 },
  title: { fontSize: 22, fontWeight: '700' as const, letterSpacing: 0.3 },
  heading: { fontSize: 16, fontWeight: '700' as const, letterSpacing: 0.2 },
  monoStack: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
} as const;

/** Motion constants — single source of truth for durations & spring physics. */
export const motion = {
  pressMs: 120,
  modalInMs: 180,
  splash: {
    /** `WIS` wordmark fade-in, opacity 0 -> 1. */
    wisFadeInMs: 450,
    /** The amber `+` spring: high velocity from off-screen right. */
    plusSpring: { damping: 14, stiffness: 280, mass: 0.9 },
    /** Amber glow pulse after the `+` snaps into place. */
    glowPulseMs: { up: 130, down: 340 },
    /** Whole-splash fade-out into the main app. */
    exitFadeMs: 350,
    /** Never cut the splash before this many ms have elapsed. */
    minVisibleMs: 1600,
    /** /api/health polling cadence while the sidecar boots. */
    healthPollMs: 400,
    /** Give up waiting for the backend after this long (app shows offline). */
    healthTimeoutMs: 8000,
  },
} as const;
