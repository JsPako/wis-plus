/**
 * WIS+ Theme Engine (Task 7.5)
 * ============================
 * Eight built-in garage themes + user-defined custom themes served from the
 * sidecar's `GET /api/themes` (files dropped into the project-root `themes/`
 * directory, or imported/created in Settings).
 *
 * How theming works:
 *   - Every color in `tokens.ts` is a CSS custom property (`--wis-*`) with a
 *     Workshop Dark hex fallback. The provider writes the active theme's
 *     palette (plus derived colors) into those variables on `<html>`, so the
 *     entire app re-skins instantly — no per-component rewiring, zero extra
 *     render cost, and `tokens.ts` stays a valid static default export.
 *   - The active theme id is persisted in the git-ignored `user_config.json`
 *     via `POST /api/profile {active_theme_id}` (merge semantics on the
 *     backend, so it never clobbers the vehicle profile).
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { api } from '@/api/client';
import type { CustomThemeJson } from '@/types/api';

// ---------------------------------------------------------------------------
// Types — the canonical 11-color palette (mirrors backend/theme_loader.py)
// ---------------------------------------------------------------------------
export interface ThemeColors {
  bgPrimary: string;
  bgSurface: string;
  bgElevated: string;
  borderSubtle: string;
  accentPrimary: string;
  accentSecondary: string;
  verifyGreen: string;
  dangerRed: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
}

/** Stable key order — used by the Settings custom-theme editor. */
export const THEME_COLOR_KEYS = [
  'bgPrimary',
  'bgSurface',
  'bgElevated',
  'borderSubtle',
  'accentPrimary',
  'accentSecondary',
  'verifyGreen',
  'dangerRed',
  'textPrimary',
  'textSecondary',
  'textMuted',
] as const satisfies readonly (keyof ThemeColors)[];

/** Human labels for the Settings color editor. */
export const COLOR_KEY_LABELS: Record<keyof ThemeColors, string> = {
  bgPrimary: 'Background',
  bgSurface: 'Surface / cards',
  bgElevated: 'Elevated / selected',
  borderSubtle: 'Borders',
  accentPrimary: 'Accent (actions)',
  accentSecondary: 'Accent secondary',
  verifyGreen: 'Verify green',
  dangerRed: 'Danger red',
  textPrimary: 'Text primary',
  textSecondary: 'Text secondary',
  textMuted: 'Text muted',
};

export interface ThemeDefinition {
  id: string;
  name: string;
  description: string;
  author: string;
  isDark: boolean;
  colors: ThemeColors;
}

export const DEFAULT_THEME_ID = 'workshop-dark';

// ---------------------------------------------------------------------------
// Built-in presets — tuned for garage readability (contrast + glare)
// ---------------------------------------------------------------------------
export const BUILT_IN_THEMES: readonly ThemeDefinition[] = [
  {
    id: 'workshop-dark',
    name: 'Workshop Dark',
    description:
      'The default. Deep matte charcoal with Mercedes signal amber — easy on the eyes under a bay lamp at midnight.',
    author: 'WIS+ Team',
    isDark: true,
    colors: {
      bgPrimary: '#121417',
      bgSurface: '#1B1F24',
      bgElevated: '#242930',
      borderSubtle: '#2E343C',
      accentPrimary: '#E5A93C',
      accentSecondary: '#8FB6D9',
      verifyGreen: '#2EA043',
      dangerRed: '#DA3633',
      textPrimary: '#F0F3F6',
      textSecondary: '#9BA3AF',
      textMuted: '#5F6771',
    },
  },
  {
    id: 'daylight-garage',
    name: 'Daylight High-Contrast',
    description:
      'Cool alabaster with deep amber — built for outdoor sun and open-bay daylight where dark UIs wash out.',
    author: 'WIS+ Team',
    isDark: false,
    colors: {
      bgPrimary: '#F3F5F8',
      bgSurface: '#FFFFFF',
      bgElevated: '#E4E9EF',
      borderSubtle: '#C7D0DA',
      accentPrimary: '#B45309',
      accentSecondary: '#1D4ED8',
      verifyGreen: '#15803D',
      dangerRed: '#B91C1C',
      textPrimary: '#16181B',
      textSecondary: '#4B5563',
      textMuted: '#8A94A0',
    },
  },
  {
    id: 'mercedes-w201',
    name: 'Mercedes W201 Classic',
    description:
      'VDO cluster onyx with needle orange and malachite green — the instrument panel of a ’89 C-Class, digitized.',
    author: 'WIS+ Team',
    isDark: true,
    colors: {
      bgPrimary: '#0E1013',
      bgSurface: '#16191D',
      bgElevated: '#1F242A',
      borderSubtle: '#2C333B',
      accentPrimary: '#FF8C24',
      accentSecondary: '#1F6E58',
      verifyGreen: '#34A06B',
      dangerRed: '#D24B4B',
      textPrimary: '#EDEAE2',
      textSecondary: '#A8A29A',
      textMuted: '#6B665E',
    },
  },
  {
    id: 'green-crt',
    name: 'GreenCRT',
    description:
      '1980s P31 green phosphor. Pure terminal glow — for the purist who reads torque specs like a boot log.',
    author: 'WIS+ Team',
    isDark: true,
    colors: {
      bgPrimary: '#061108',
      bgSurface: '#0A1A0F',
      bgElevated: '#0F2415',
      borderSubtle: '#1C3A26',
      accentPrimary: '#33FF66',
      accentSecondary: '#A8FFC0',
      verifyGreen: '#2EE86B',
      dangerRed: '#FF5555',
      textPrimary: '#33FF66',
      textSecondary: '#2ABF55',
      textMuted: '#1E7A3C',
    },
  },
  {
    id: 'orange-crt',
    name: 'OrangeCRT',
    description:
      '1980s amber plasma phosphor. Warm glow for the late-night service manual session.',
    author: 'WIS+ Team',
    isDark: true,
    colors: {
      bgPrimary: '#120A04',
      bgSurface: '#1A0F06',
      bgElevated: '#241507',
      borderSubtle: '#3A2410',
      accentPrimary: '#FFB000',
      accentSecondary: '#FFD980',
      verifyGreen: '#7CC243',
      dangerRed: '#FF4438',
      textPrimary: '#FFB000',
      textSecondary: '#C98A2E',
      textMuted: '#7A541F',
    },
  },
  {
    id: 'blueprint-cad',
    name: 'Sindelfingen Blueprint',
    description:
      'Engineering prussian blue with technical white and cyan — the look of a folded W201 CAD drawing.',
    author: 'WIS+ Team',
    isDark: true,
    colors: {
      bgPrimary: '#0B1E36',
      bgSurface: '#10294A',
      bgElevated: '#16345C',
      borderSubtle: '#1D3A63',
      accentPrimary: '#38BDF8',
      accentSecondary: '#F0F7FF',
      verifyGreen: '#34D399',
      dangerRed: '#F87171',
      textPrimary: '#F0F7FF',
      textSecondary: '#A9C3DE',
      textMuted: '#5E7BA3',
    },
  },
  {
    id: 'haynes-newsprint',
    name: 'Haynes Paper Manual',
    description:
      'Warm newsprint with printer ink and cover red — like turning the pages of a real Haynes workshop manual.',
    author: 'WIS+ Team',
    isDark: false,
    colors: {
      bgPrimary: '#F4EFE6',
      bgSurface: '#FBF8F1',
      bgElevated: '#EAE2D3',
      borderSubtle: '#D8CDB8',
      accentPrimary: '#C81E1E',
      accentSecondary: '#44403C',
      verifyGreen: '#2F6B3A',
      dangerRed: '#A31515',
      textPrimary: '#1C1917',
      textSecondary: '#4A443C',
      textMuted: '#8A8072',
    },
  },
  {
    id: 'dtm-evo-silver',
    name: '190E Evo II Motorsport',
    description:
      'Astral silver slate with racing crimson — DTM livery for when the car is heading to the track, not the shop.',
    author: 'WIS+ Team',
    isDark: true,
    colors: {
      bgPrimary: '#181C22',
      bgSurface: '#1F242C',
      bgElevated: '#29303B',
      borderSubtle: '#39414E',
      accentPrimary: '#E11D48',
      accentSecondary: '#C0C7D1',
      verifyGreen: '#2EA043',
      dangerRed: '#FF6B2C',
      textPrimary: '#EEF1F5',
      textSecondary: '#A3ABB8',
      textMuted: '#6C7580',
    },
  },
];

// ---------------------------------------------------------------------------
// Color math + derived palette (text-on-accent, hairlines, scrims…)
// ---------------------------------------------------------------------------
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  const n = parseInt(full || '000000', 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `#RRGGBB` / `#RRGGBBAA` -> `rgba(r, g, b, alpha)` string. */
export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** WCAG relative luminance of a hex color (0 = black, 1 = white). */
function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export interface DerivedThemeColors {
  textOnAccent: string;
  hairline: string;
  hairlineStrong: string;
  scrim: string;
  accentDim: string;
  shadow: string;
}

/** Colors the palette doesn't define but components need (buttons, scrims). */
export function derivePalette(theme: ThemeDefinition): DerivedThemeColors {
  const { isDark } = theme;
  const c = theme.colors;
  return {
    textOnAccent: relativeLuminance(c.accentPrimary) > 0.45 ? '#121417' : '#FFFFFF',
    hairline: withAlpha(c.textPrimary, isDark ? 0.08 : 0.1),
    hairlineStrong: withAlpha(c.textPrimary, isDark ? 0.16 : 0.2),
    scrim: isDark ? 'rgba(9, 10, 12, 0.62)' : 'rgba(255, 255, 255, 0.45)',
    accentDim: withAlpha(c.accentPrimary, isDark ? 0.14 : 0.12),
    shadow: isDark ? 'rgba(0, 0, 0, 0.5)' : 'rgba(15, 23, 42, 0.16)',
  };
}

// ---------------------------------------------------------------------------
// DOM application — theme switch = rewrite CSS variables on <html>
// ---------------------------------------------------------------------------
const COLOR_VAR_MAP: Record<keyof ThemeColors, string> = {
  bgPrimary: '--wis-bg-primary',
  bgSurface: '--wis-bg-surface',
  bgElevated: '--wis-bg-elevated',
  borderSubtle: '--wis-border-subtle',
  accentPrimary: '--wis-accent-primary',
  accentSecondary: '--wis-accent-secondary',
  verifyGreen: '--wis-verify-green',
  dangerRed: '--wis-danger-red',
  textPrimary: '--wis-text-primary',
  textSecondary: '--wis-text-secondary',
  textMuted: '--wis-text-muted',
};

const DERIVED_VAR_MAP: Record<keyof DerivedThemeColors, string> = {
  textOnAccent: '--wis-text-on-accent',
  hairline: '--wis-hairline',
  hairlineStrong: '--wis-hairline-strong',
  scrim: '--wis-scrim',
  accentDim: '--wis-accent-dim',
  shadow: '--wis-shadow',
};

/** Write the active palette into CSS custom properties (idempotent, cheap). */
export function applyThemeToDom(theme: ThemeDefinition): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  for (const key of THEME_COLOR_KEYS) {
    root.style.setProperty(COLOR_VAR_MAP[key], theme.colors[key]);
  }
  const derived = derivePalette(theme);
  for (const key of Object.keys(DERIVED_VAR_MAP) as (keyof DerivedThemeColors)[]) {
    root.style.setProperty(DERIVED_VAR_MAP[key], derived[key]);
  }
}

// ---------------------------------------------------------------------------
// Client-side validation (mirrors backend/theme_loader.py so the Settings
// import panel can reject bad files before they hit the sidecar)
// ---------------------------------------------------------------------------
const HEX_RE = /^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type ThemeValidationResult =
  | { ok: true; theme: ThemeDefinition }
  | { ok: false; error: string };

export function validateThemeJson(raw: unknown): ThemeValidationResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'Theme file must be a JSON object.' };
  }
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim().toLowerCase() : '';
  if (!ID_RE.test(id)) {
    return { ok: false, error: `'id' must be a lowercase slug (a-z, 0-9, dashes), e.g. "my-garage".` };
  }
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  if (!name || name.length > 80) {
    return { ok: false, error: `'name' is required (1–80 characters).` };
  }
  const colorsRaw = (o.colors ?? {}) as Record<string, unknown>;
  const colors = {} as Record<keyof ThemeColors, string>;
  for (const key of THEME_COLOR_KEYS) {
    const v = colorsRaw[key];
    if (typeof v !== 'string' || !HEX_RE.test(v)) {
      return { ok: false, error: `colors.${key} must be a #RRGGBB or #RRGGBBAA hex string.` };
    }
    colors[key] = v.toUpperCase();
  }
  return {
    ok: true,
    theme: {
      id,
      name,
      description: typeof o.description === 'string' ? o.description.slice(0, 500) : '',
      author: typeof o.author === 'string' && o.author.trim() ? o.author.trim().slice(0, 80) : 'WIS+ user',
      isDark: typeof o.isDark === 'boolean' ? o.isDark : true,
      colors: colors as ThemeColors,
    },
  };
}

// ---------------------------------------------------------------------------
// Context / provider
// ---------------------------------------------------------------------------
interface ThemeContextValue {
  /** The currently active theme (never undefined — falls back to Workshop Dark). */
  theme: ThemeDefinition;
  activeThemeId: string;
  /** Built-ins first, then valid custom themes from the themes/ folder. */
  availableThemes: ThemeDefinition[];
  /** Only the user-defined ones (from GET /api/themes). */
  customThemes: ThemeDefinition[];
  /** Switch theme + persist to user_config.json (safe offline — local first). */
  setTheme: (id: string) => Promise<void>;
  /** Validate, POST to /api/themes, refresh the list; optionally activate. */
  importCustomTheme: (
    input: string | object,
    opts?: { activate?: boolean },
  ) => Promise<ThemeDefinition>;
  /** Re-scan ./themes/*.json via GET /api/themes. */
  reloadThemes: () => Promise<void>;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function normalizeCustomTheme(raw: CustomThemeJson): ThemeDefinition | null {
  const v = validateThemeJson(raw);
  return v.ok ? v.theme : null;
}

export function ThemeProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [activeThemeId, setActiveThemeId] = useState<string>(DEFAULT_THEME_ID);
  const [customThemes, setCustomThemes] = useState<ThemeDefinition[]>([]);

  const reloadThemes = useCallback(async (): Promise<void> => {
    try {
      const list = await api.getThemes();
      setCustomThemes(list.map(normalizeCustomTheme).filter((t): t is ThemeDefinition => t !== null));
    } catch {
      // Sidecar offline — keep whatever is already in memory.
    }
  }, []);

  // Boot: restore the persisted theme id + scan the themes/ folder.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const p = await api.getProfile();
        if (!cancelled && typeof p.active_theme_id === 'string' && p.active_theme_id) {
          setActiveThemeId(p.active_theme_id);
        }
      } catch {
        // offline — default theme stays
      }
      await reloadThemes();
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadThemes]);

  const availableThemes = useMemo(() => {
    const byId = new Map<string, ThemeDefinition>();
    for (const t of BUILT_IN_THEMES) byId.set(t.id, t);
    for (const t of customThemes) if (!byId.has(t.id)) byId.set(t.id, t);
    return [...byId.values()];
  }, [customThemes]);

  const theme = useMemo(
    () => availableThemes.find((t) => t.id === activeThemeId) ?? BUILT_IN_THEMES[0],
    [availableThemes, activeThemeId],
  );

  // Theme switch = rewrite CSS variables; the whole app re-skins instantly.
  useEffect(() => {
    applyThemeToDom(theme);
  }, [theme]);

  const setTheme = useCallback(async (id: string): Promise<void> => {
    setActiveThemeId(id);                       // optimistic — works offline
    try {
      await api.setActiveTheme(id);             // persist (merge, never clobbers)
    } catch {
      // sidecar offline — theme still applies for this session
    }
  }, []);

  const importCustomTheme = useCallback(
    async (input: string | object, opts?: { activate?: boolean }): Promise<ThemeDefinition> => {
      let obj: unknown;
      if (typeof input === 'string') {
        try {
          obj = JSON.parse(input);
        } catch {
          throw new Error('Invalid JSON — the theme file could not be parsed.');
        }
      } else {
        obj = input;
      }
      const v = validateThemeJson(obj);
      if (!v.ok) throw new Error(v.error);
      try {
        await api.importTheme(v.theme as CustomThemeJson);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Could not save theme: ${msg}`);
      }
      await reloadThemes();
      if (opts?.activate) await setTheme(v.theme.id);
      return v.theme;
    },
    [reloadThemes, setTheme],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, activeThemeId, availableThemes, customThemes, setTheme, importCustomTheme, reloadThemes }),
    [theme, activeThemeId, availableThemes, customThemes, setTheme, importCustomTheme, reloadThemes],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme() must be used inside <ThemeProvider>');
  return ctx;
}
