/**
 * WIS+ Settings screen (Task 7.5).
 *
 * Opened from the ⚙️ button in the top bar. Two sections:
 *   1. Appearance & Themes — live theme grid (8 built-ins + custom themes
 *      from ./themes/*.json), a 'Reload themes/ Folder' button, and an
 *      Import / Create Custom Theme panel (file upload or live hex editor).
 *   2. Vehicle Profile — engine + transmission selectors (same options as
 *      the onboarding modal) so the car profile can be changed anytime.
 *
 * Tauri webview notes: RNW has no file picker or color picker, so those two
 * controls are plain DOM <input> elements rendered via React.createElement.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { api, ApiError } from '@/api/client';
import {
  COLOR_KEY_LABELS,
  THEME_COLOR_KEYS,
  useTheme,
  type ThemeColors,
  type ThemeDefinition,
} from '@/theme/ThemeContext';
import { colors, radius, spacing, typography } from '@/theme/tokens';
import {
  ENGINE_OPTIONS,
  TRANSMISSION_OPTIONS,
  optionLabel,
  type ProfileOption,
  type VehicleProfile,
} from '@/types/api';

// ---------------------------------------------------------------------------
// DOM helpers (Tauri webview = a browser under the hood)
// ---------------------------------------------------------------------------
function domInput(props: Record<string, unknown>): React.ReactElement {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return React.createElement('input', props as any);
}

/** Force the native file picker; resolves with (filename, text). */
function pickJsonFile(onPicked: (name: string, text: string) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.style.display = 'none';
  input.onchange = () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onPicked(file.name, String(reader.result ?? ''));
    reader.onerror = () => onPicked(file.name, '');
    reader.readAsText(file);
  };
  document.body.appendChild(input);
  input.click();
  window.setTimeout(() => input.remove(), 1000);
}

/** '#RRGGBBAA' -> '#RRGGBB' (native color inputs only accept 6 digits). */
function toSixDigit(hex: string): string {
  return /^#[0-9A-Fa-f]{6}$/.test(hex) ? hex : hex.slice(0, 7);
}

/** 'My Garage Theme' -> 'my-garage-theme' (theme id slug). */
function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------
function SectionTitle({ children }: { children: React.ReactNode }) {
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

function StatusLine({ status }: { status: { kind: 'ok' | 'err'; text: string } | null }) {
  if (!status) return null;
  return (
    <Text style={[styles.status, { color: status.kind === 'ok' ? colors.verifyGreen : colors.dangerRed }]}
      numberOfLines={3}>
      {status.text}
    </Text>
  );
}

const SWATCH_KEYS: readonly (keyof ThemeColors)[] = ['bgPrimary', 'bgSurface', 'accentPrimary', 'verifyGreen'];

function ThemeCard({
  theme,
  active,
  isCustom,
  onSelect,
}: {
  theme: ThemeDefinition;
  active: boolean;
  isCustom: boolean;
  onSelect: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onSelect}
      style={({ pressed }) => [
        styles.themeCard,
        { borderColor: active ? colors.accentPrimary : colors.hairlineStrong },
        pressed && { opacity: 0.85 },
      ]}
    >
      <View style={styles.swatchRow}>
        {SWATCH_KEYS.map((k) => (
          <View key={k} style={[styles.swatch, { backgroundColor: theme.colors[k] }]} />
        ))}
        <View style={styles.cardBadgeRow}>
          {isCustom && <Text style={styles.customBadge}>CUSTOM</Text>}
          {active && (
            <View style={styles.activeBadge}>
              <Text style={styles.activeBadgeText}>ACTIVE</Text>
            </View>
          )}
        </View>
      </View>
      <Text style={styles.themeName} numberOfLines={1}>{theme.name}</Text>
      <Text style={styles.themeDesc} numberOfLines={3}>{theme.description || 'No description.'}</Text>
      <Text style={styles.themeAuthor} numberOfLines={1}>by {theme.author} · {theme.isDark ? 'dark' : 'light'}</Text>
    </Pressable>
  );
}

function OptionRow({ options, value, onChange }: {
  options: readonly ProfileOption[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <View style={{ flexWrap: 'wrap', gap: spacing.sm }}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="button"
            onPress={() => onChange(o.value)}
            style={({ pressed }) => [
              styles.optionChip,
              selected && { backgroundColor: colors.accentPrimary, borderColor: colors.accentPrimary },
              pressed && { opacity: 0.85 },
            ]}
          >
            <Text numberOfLines={1} style={[styles.optionChipText, selected && { color: colors.textOnAmber }]}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------
export interface SettingsViewProps {
  onBack: () => void;
  profile: VehicleProfile | null;
  onProfileSaved: (profile: VehicleProfile) => void;
}

interface ThemeDraft {
  name: string;
  author: string;
  isDark: boolean;
  colors: ThemeColors;
}

export default function SettingsView({ onBack, profile, onProfileSaved }: SettingsViewProps): React.ReactElement {
  const { theme, activeThemeId, availableThemes, customThemes, setTheme, importCustomTheme, reloadThemes } =
    useTheme();

  // -- Section 1: themes -----------------------------------------------------
  const [reloadBusy, setReloadBusy] = useState(false);
  const [importStatus, setImportStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [draft, setDraft] = useState<ThemeDraft>(() => ({
    name: '',
    author: 'WIS+ user',
    isDark: true,
    colors: { ...theme.colors },
  }));

  const openDraft = useCallback(() => {
    // Seed the editor from the active theme so users tweak what they see.
    setDraft({ name: '', author: 'WIS+ user', isDark: theme.isDark, colors: { ...theme.colors } });
    setImportStatus(null);
    setDraftOpen(true);
  }, [theme]);

  const handleReload = useCallback(async () => {
    setReloadBusy(true);
    await reloadThemes();
    setReloadBusy(false);
  }, [reloadThemes]);

  const handleFileImport = useCallback(
    (fileName: string, text: string) => {
      void (async () => {
        try {
          if (!text) throw new Error('could not read the file.');
          const created = await importCustomTheme(text);
          setImportStatus({ kind: 'ok', text: `Imported "${created.name}" from ${fileName}. Tap its card to activate.` });
        } catch (err) {
          setImportStatus({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
        }
      })();
    },
    [importCustomTheme],
  );

  const handleCreateTheme = useCallback(async () => {
    try {
      const id = slugify(draft.name);
      if (!id) throw new Error('Give the theme a name first.');
      const created = await importCustomTheme(
        {
          id,
          name: draft.name.trim(),
          description: 'Created in WIS+ Settings.',
          author: draft.author.trim() || 'WIS+ user',
          isDark: draft.isDark,
          colors: draft.colors,
        },
        { activate: true },
      );
      setImportStatus({ kind: 'ok', text: `Theme "${created.name}" saved to themes/${created.id}.json and activated.` });
      setDraftOpen(false);
    } catch (err) {
      setImportStatus({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
    }
  }, [draft, importCustomTheme]);

  const setColor = useCallback((key: keyof ThemeColors, value: string) => {
    setDraft((d) => ({ ...d, colors: { ...d.colors, [key]: value } }));
  }, []);

  // -- Section 2: vehicle profile --------------------------------------------
  const [engine, setEngine] = useState<string>(profile?.engine ?? 'ALL');
  const [transmission, setTransmission] = useState<string>(profile?.transmission ?? 'ALL');
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileStatus, setProfileStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    if (profile) {
      setEngine(profile.engine);
      setTransmission(profile.transmission);
    }
  }, [profile]);

  const handleSaveProfile = useCallback(async () => {
    setSavingProfile(true);
    setProfileStatus(null);
    try {
      const saved = await api.saveProfile({ engine, transmission });
      onProfileSaved(saved);
      setProfileStatus({ kind: 'ok', text: 'Vehicle profile saved.' });
    } catch (err) {
      setProfileStatus({
        kind: 'err',
        text: err instanceof ApiError ? err.message : 'Could not save the vehicle profile.',
      });
    } finally {
      setSavingProfile(false);
    }
  }, [engine, transmission, onProfileSaved]);

  const customIds = useMemo(() => new Set(customThemes.map((t) => t.id)), [customThemes]);

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {/* Header ------------------------------------------------------------ */}
        <Pressable
          accessibilityRole="button"
          onPress={onBack}
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.85 }]}
        >
          <Text style={styles.backBtnText}>← Back to Directory</Text>
        </Pressable>
        <Text style={styles.title}>⚙️ Settings</Text>

        {/* Section 1 — Appearance & Themes ------------------------------------ */}
        <View style={styles.sectionHeader}>
          <SectionTitle>Appearance &amp; Themes</SectionTitle>
          <Pressable
            accessibilityRole="button"
            onPress={() => void handleReload()}
            disabled={reloadBusy}
            style={({ pressed }) => [styles.reloadBtn, (pressed || reloadBusy) && { opacity: 0.7 }]}
          >
            <Text style={styles.reloadBtnText}>{reloadBusy ? 'Scanning…' : '⟳ Reload themes/ Folder'}</Text>
          </Pressable>
        </View>

        <View style={styles.themeGrid}>
          {availableThemes.map((t) => (
            <ThemeCard
              key={t.id}
              theme={t}
              active={t.id === activeThemeId}
              isCustom={customIds.has(t.id)}
              onSelect={() => void setTheme(t.id)}
            />
          ))}
        </View>

        {/* Import / Create custom theme ---------------------------------------- */}
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Import / Create Custom Theme</Text>
          <Text style={styles.panelHint}>
            Drop a .json theme file into the project-root themes/ folder and hit 'Reload', or import one right
            here. Template: themes/example-custom-theme.json.
          </Text>

          <Pressable
            accessibilityRole="button"
            onPress={() => pickJsonFile(handleFileImport)}
            style={({ pressed }) => [styles.importBtn, pressed && { opacity: 0.85 }]}
          >
            <Text style={styles.importBtnText}>📄 Import theme .json file…</Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            onPress={() => (draftOpen ? setDraftOpen(false) : openDraft())}
            style={({ pressed }) => [styles.importBtn, styles.secondaryBtn, pressed && { opacity: 0.85 }]}
          >
            <Text style={styles.importBtnText}>
              {draftOpen ? 'Hide custom theme editor' : '🎨 Create a custom theme (live hex editor)'}
            </Text>
          </Pressable>

          {draftOpen && (
            <View style={styles.draftBox}>
              <View style={styles.fieldRow}>
                <Text style={styles.fieldLabel}>Name</Text>
                <TextInput
                  value={draft.name}
                  onChangeText={(v) => setDraft((d) => ({ ...d, name: v }))}
                  placeholder="e.g. My Garage"
                  maxLength={80}
                  style={styles.textInput}
                />
              </View>
              <View style={styles.fieldRow}>
                <Text style={styles.fieldLabel}>Author</Text>
                <TextInput
                  value={draft.author}
                  onChangeText={(v) => setDraft((d) => ({ ...d, author: v }))}
                  placeholder="WIS+ user"
                  maxLength={80}
                  style={styles.textInput}
                />
              </View>
              <View style={styles.fieldRow}>
                <Text style={styles.fieldLabel}>Mode</Text>
                <View style={{ gap: spacing.sm }}>
                  {([true, false] as const).map((dark) => (
                    <Pressable
                      key={String(dark)}
                      accessibilityRole="button"
                      onPress={() => setDraft((d) => ({ ...d, isDark: dark }))}
                      style={({ pressed }) => [
                        styles.modeChip,
                        draft.isDark === dark && { backgroundColor: colors.accentPrimary },
                        pressed && { opacity: 0.85 },
                      ]}
                    >
                      <Text
                        numberOfLines={1}
                        style={[styles.modeChipText, draft.isDark === dark && { color: colors.textOnAmber }]}
                      >
                        {dark ? '🌙 Dark' : '☀️ Light'}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              <Text style={styles.fieldLabel}>Colors (hex or picker)</Text>
              {THEME_COLOR_KEYS.map((key) => (
                <View key={key} style={styles.colorRow}>
                  <Text numberOfLines={1} style={styles.colorLabel}>{COLOR_KEY_LABELS[key]}</Text>
                  {domInput({
                    type: 'color',
                    value: toSixDigit(draft.colors[key]),
                    onChange: (e: React.FormEvent<HTMLInputElement>) => setColor(key, e.target.value.toUpperCase()),
                    style: { width: 34, height: 26, padding: 0, border: `1px solid ${colors.hairlineStrong}`, borderRadius: radius.sm, background: 'transparent', cursor: 'pointer' },
                  })}
                  <TextInput
                    value={draft.colors[key]}
                    onChangeText={(v) => setColor(key, v)}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    maxLength={9}
                    style={[styles.hexInput, { fontFamily: typography.monoStack }]}
                  />
                </View>
              ))}

              <Pressable
                accessibilityRole="button"
                onPress={() => void handleCreateTheme()}
                style={({ pressed }) => [styles.saveBtn, pressed && { opacity: 0.85 }]}
              >
                <Text style={styles.saveBtnText}>💾 Save &amp; Activate</Text>
              </Pressable>
            </View>
          )}

          <StatusLine status={importStatus} />
        </View>

        {/* Section 2 — Vehicle Profile ----------------------------------------- */}
        <SectionTitle>Vehicle Profile</SectionTitle>
        <View style={styles.panel}>
          <Text style={styles.fieldLabel}>Engine</Text>
          <OptionRow options={ENGINE_OPTIONS} value={engine} onChange={setEngine} />

          <Text style={[styles.fieldLabel, { marginTop: spacing.lg }]}>Transmission</Text>
          <OptionRow options={TRANSMISSION_OPTIONS} value={transmission} onChange={setTransmission} />

          <Pressable
            accessibilityRole="button"
            onPress={() => void handleSaveProfile()}
            disabled={savingProfile}
            style={({ pressed }) => [styles.saveBtn, (pressed || savingProfile) && { opacity: 0.75 }]}
          >
            <Text style={styles.saveBtnText}>{savingProfile ? 'Saving…' : '💾 Save Vehicle Profile'}</Text>
          </Pressable>
          <StatusLine status={profileStatus} />
          <Text style={styles.panelHint}>
            Current: {optionLabel(ENGINE_OPTIONS, profile?.engine)} · {optionLabel(TRANSMISSION_OPTIONS, profile?.transmission)}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles (token-driven — the screen re-skins itself with the active theme)
// ---------------------------------------------------------------------------
const styles = {
  root: { flex: 1, backgroundColor: colors.bgPrimary },
  content: { padding: spacing.xl, gap: spacing.lg },

  backBtn: { alignSelf: 'flex-start', paddingHorizontal: spacing.md, paddingVertical: spacing.xs + 2, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.hairlineStrong, backgroundColor: colors.bgSurface },
  backBtnText: { ...typography.caption, color: colors.textSecondary },
  title: { ...typography.title, marginBottom: spacing.xs },

  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionTitle: { ...typography.heading },

  reloadBtn: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.accentPrimary, backgroundColor: colors.amberDim },
  reloadBtnText: { ...typography.caption, color: colors.accentPrimary },

  themeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg },
  themeCard: { width: 300, maxWidth: '100%', backgroundColor: colors.bgSurface, borderRadius: radius.lg, borderWidth: 2, padding: spacing.lg, gap: spacing.sm },
  swatchRow: { flexDirection: 'row', gap: spacing.xs, alignItems: 'center' },
  swatch: { width: 40, height: 28, borderRadius: radius.sm, borderWidth: 1, borderColor: 'rgba(127, 127, 127, 0.35)' },
  cardBadgeRow: { flex: 1, flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.xs },
  customBadge: { ...typography.caption, fontSize: 9, color: colors.accentSecondary, backgroundColor: colors.bgElevated, paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.pill, overflow: 'hidden' },
  activeBadge: { backgroundColor: colors.verifyGreen, borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  activeBadgeText: { ...typography.caption, fontSize: 9, color: '#FFFFFF' },
  themeName: { ...typography.heading, marginTop: spacing.xs },
  themeDesc: { ...typography.body, color: colors.textSecondary, lineHeight: 18 },
  themeAuthor: { ...typography.caption, color: colors.textMuted },

  panel: { backgroundColor: colors.bgSurface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.hairlineStrong, padding: spacing.xl, gap: spacing.md },
  panelTitle: { ...typography.heading },
  panelHint: { ...typography.caption, color: colors.textMuted, lineHeight: 17 },

  importBtn: { backgroundColor: colors.accentPrimary, borderRadius: radius.md, paddingVertical: spacing.md, alignItems: 'center' },
  secondaryBtn: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.accentPrimary },
  importBtnText: { ...typography.body, color: colors.textOnAmber },

  draftBox: { gap: spacing.md, backgroundColor: colors.bgElevated, borderRadius: radius.md, padding: spacing.lg },
  fieldRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  fieldLabel: { ...typography.caption, color: colors.textSecondary, marginBottom: spacing.xs },
  textInput: { flex: 1, ...typography.body, color: colors.textPrimary, backgroundColor: colors.bgSurface, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.hairlineStrong, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  modeChip: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.hairlineStrong, backgroundColor: colors.bgSurface },
  modeChipText: { ...typography.caption, color: colors.textPrimary },

  colorRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  colorLabel: { flex: 1, ...typography.body, color: colors.textSecondary },
  hexInput: { width: 96, textAlign: 'center', ...typography.body, fontSize: 13, color: colors.textPrimary, backgroundColor: colors.bgSurface, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.hairlineStrong, paddingHorizontal: spacing.sm, paddingVertical: 4 },

  saveBtn: { backgroundColor: colors.accentPrimary, borderRadius: radius.md, paddingVertical: spacing.md, alignItems: 'center', marginTop: spacing.xs },
  saveBtnText: { ...typography.body, fontWeight: '700', color: colors.textOnAmber },

  optionChip: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.hairlineStrong, backgroundColor: colors.bgElevated },
  optionChipText: { ...typography.body, color: colors.textPrimary },

  status: { ...typography.caption, lineHeight: 17 },
} satisfies Record<string, React.CSSProperties & object>;
