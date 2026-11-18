/**
 * WIS+ design tokens — "W201 Workshop Dark".
 *
 * A high-contrast garage palette: deep matte charcoal surfaces, one loud
 * accent (Mercedes signal amber) for actions and the brand "+", plus clear
 * verify-green / danger-red status colors. Every screen in the app must pull
 * from these tokens — no raw hex values in components.
 */

export const colors = {
  // Core surfaces -----------------------------------------------------------
  bgPrimary: '#121417',      // app background (deep matte charcoal)
  bgSurface: '#1B1F24',      // cards, panels, modal bodies
  bgElevated: '#242930',     // selected rows, chips, hover surfaces

  // Accents & status ---------------------------------------------------------
  accentAmber: '#E5A93C',    // Mercedes signal amber — primary action + brand "+"
  verifyGreen: '#2EA043',    // "verified against the original scan"
  dangerRed: '#DA3633',      // errors, unverified / possibly-misread values

  // Text ----------------------------------------------------------------------
  textPrimary: '#F0F3F6',    // metallic white
  textSecondary: '#9BA3AF',  // muted labels, hints

  // Derived (kept here so components never invent new hex) --------------------
  textOnAmber: '#121417',    // text on amber buttons
  hairline: 'rgba(240, 243, 246, 0.08)',
  hairlineStrong: 'rgba(240, 243, 246, 0.16)',
  scrim: 'rgba(9, 10, 12, 0.62)',
  amberDim: 'rgba(229, 169, 60, 0.14)',
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
