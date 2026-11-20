/**
 * WIS+ root component — Task 8 final assembly.
 *
 * Boot sequence: animated SplashScreen (WIS fade-in + amber "+" slide) until
 * `/api/health` responds, then the main shell:
 *
 *   ┌──────────────────────────────── top bar ────────────────────────────────┐
 *   │ [← Back to Directory]  WIS+  [🔍 Spotlight Ctrl+Enter]  All|WIS|Haynes  [profile pill]  ⚙ Settings │
 *   ├───────────────┬─────────────────────────────────────────────────────────┤
 *   │ CategorySidebar (animated collapse)  │        routed view               │
 *   │                    'directory' | 'procedure' | 'settings'              │
 *   └───────────────┴─────────────────────────────────────────────────────────┘
 *
 * Global layers: ProfileModal (auto-opens when `profile.configured === false`)
 * and the QuickSearch Spotlight (Ctrl+Enter from any screen, Esc closes).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { api } from '@/api/client';
import CategorySidebar, { type OpenedProcedureRef } from '@/components/CategorySidebar';
import ProfileModal from '@/components/ProfileModal';
import QuickSearch from '@/components/QuickSearch';
import SplashScreen from '@/components/SplashScreen';
import ToolboxDrawer from '@/components/ToolboxDrawer';
import { ToolboxProvider, useToolbox } from '@/state/ToolboxContext';
import ProcedureView from '@/screens/ProcedureView';
import SettingsView from '@/screens/SettingsView';
import { ThemeProvider } from '@/theme/ThemeContext';
import {
  ENGINE_OPTIONS,
  TRANSMISSION_OPTIONS,
  optionLabel,
  type DirectoryCategory,
  type HealthResponse,
  type VehicleProfile,
} from '@/types/api';
import { colors, radius, spacing, typography } from '@/theme/tokens';
import { useGlobalShortcuts } from '@/hooks/useGlobalShortcuts';

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

type AppView = 'directory' | 'procedure' | 'settings';
type SourceFilter = 'ALL' | 'WIS' | 'HAYNES';

interface FocusedProcedure { id: number; title: string }
interface RecentItem { id: number; title: string }

const RECENT_KEY = 'wisplus.recent.v1';
const MAX_RECENT = 8;

const SOURCE_FILTERS: ReadonlyArray<{ value: SourceFilter; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'WIS', label: 'WIS' },
  { value: 'HAYNES', label: 'Haynes' },
];

function loadRecent(): RecentItem[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as unknown[])
      .filter((r): r is RecentItem => {
        const o = r as RecentItem;
        return typeof o?.id === 'number' && typeof o?.title === 'string';
      })
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

function persistRecent(items: RecentItem[]): void {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(items));
  } catch {
    // storage unavailable — recents stay in-memory only
  }
}

// ---------------------------------------------------------------------------
// Small atoms (top bar + dashboard)
// ---------------------------------------------------------------------------

function Kbd({ label }: { label: string }) {
  return (
    <View style={styles.kbd}>
      <Text style={styles.kbdText}>{label}</Text>
    </View>
  );
}

function ShortcutRow({ keys, desc }: { keys: string[]; desc: string }) {
  return (
    <View style={styles.shortcutRow}>
      <View style={styles.kbdGroup}>
        {keys.map((k) => <Kbd key={k} label={k} />)}
      </View>
      <Text style={styles.shortcutDesc}>{desc}</Text>
    </View>
  );
}

function StatChip({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' | 'err' }) {
  const valueColor =
    tone === 'ok' ? colors.verifyGreen : tone === 'warn' ? colors.accentAmber : tone === 'err' ? colors.dangerRed : colors.textPrimary;
  return (
    <View style={styles.chip}>
      <Text style={styles.chipLabel}>{label}</Text>
      <Text numberOfLines={1} style={[styles.chipValue, { color: valueColor }]}>{value}</Text>
    </View>
  );
}

/** Quick-access dashboard shown in the 'directory' view (right pane). */
function Dashboard({ health, recent, onOpenProcedure }: {
  health: HealthResponse | null;
  recent: RecentItem[];
  onOpenProcedure: (p: { id: number; title: string }) => void;
}) {
  const online = health?.status === 'ok';
  return (
    <View style={styles.dashRoot}>
      <Text style={typography.sectionLabel}>Workshop</Text>
      <Text style={styles.dashSub}>
        Pick a procedure from the directory, or press Ctrl+Enter to search everything.
      </Text>

      {/* Knowledge-base stats */}
      <View style={styles.card}>
        <Text style={styles.cardLabel}>Knowledge Base</Text>
        <View style={styles.statRow}>
          <StatChip label="Sidecar" value={online ? 'Online' : 'Offline'} tone={online ? 'ok' : 'err'} />
          <StatChip label="Procedures" value={health?.db_loaded ? String(health.procedure_count) : '—'} />
          <StatChip label="Database" value={health?.db_loaded ? 'Loaded' : 'Not loaded'} tone={health?.db_loaded ? 'ok' : 'warn'} />
        </View>
      </View>

      {/* Recently opened procedures */}
      <View style={styles.card}>
        <Text style={styles.cardLabel}>Recent Procedures</Text>
        {recent.length === 0 ? (
          <Text style={styles.emptyText}>Nothing opened yet — recent work will appear here.</Text>
        ) : (
          recent.map((r) => (
            <Pressable
              key={r.id}
              accessibilityRole="button"
              onPress={() => onOpenProcedure(r)}
              style={({ pressed }) => [styles.recentRow, pressed && { opacity: 0.8 }]}
            >
              <Text numberOfLines={1} style={styles.recentTitle}>{r.title}</Text>
              <Text style={styles.recentId}>#{r.id}</Text>
            </Pressable>
          ))
        )}
      </View>

      {/* System shortcuts */}
      <View style={styles.card}>
        <Text style={styles.cardLabel}>System Shortcuts</Text>
        <ShortcutRow keys={['Ctrl', 'Enter']} desc="Spotlight search — from any screen" />
        <ShortcutRow keys={['Esc']} desc="Back to directory / close the top layer" />
        <ShortcutRow keys={['Click']} desc="Any torque value → verify it in the original scan" />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function AppShell() {
  const [splashDone, setSplashDone] = useState(false);
  const [view, setView] = useState<AppView>('directory');
  const [focused, setFocused] = useState<FocusedProcedure | null>(null);

  // Vehicle profile + backend health.
  const [profile, setProfile] = useState<VehicleProfile | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [profileModalOpen, setProfileModalOpen] = useState(false);

  // Directory tree (Task 6).
  const [directory, setDirectory] = useState<DirectoryCategory[] | null>(null);
  const [dirLoading, setDirLoading] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);

  // Spotlight + source filter.
  const [searchOpen, setSearchOpen] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('ALL');

  // Toolbox grab list (Task 9).
  const { pinnedJobs } = useToolbox();
  const [toolboxOpen, setToolboxOpen] = useState(false);

  // Recently opened procedures (persisted per machine).
  const [recent, setRecent] = useState<RecentItem[]>(loadRecent);
  useEffect(() => { persistRecent(recent); }, [recent]);

  // --- data loading -----------------------------------------------------------
  const refreshHealth = useCallback(async () => {
    try { setHealth(await api.health()); } catch { setHealth(null); }
  }, []);

  const loadDirectory = useCallback(async () => {
    setDirLoading(true);
    setDirError(null);
    try {
      setDirectory(await api.directory(profile?.engine ?? undefined, profile?.transmission ?? undefined));
    } catch (err) {
      setDirectory(null);
      setDirError(err instanceof Error ? err.message : 'Failed to load the directory.');
    } finally {
      setDirLoading(false);
    }
  }, [profile?.engine, profile?.transmission]);

  useEffect(() => {
    if (!splashDone) return;
    void refreshHealth();
    void loadDirectory();
  }, [splashDone, refreshHealth, loadDirectory]);

  // First launch: never assume a car — prompt until the build is configured.
  useEffect(() => {
    if (splashDone && profile !== null && !profile.configured) {
      setProfileModalOpen(true);
    }
  }, [splashDone, profile]);

  // --- navigation -------------------------------------------------------------
  const openProcedure = useCallback((p: OpenedProcedureRef | { id: number; title: string }) => {
    setFocused({ id: p.id, title: p.title });
    setRecent((prev) => [{ id: p.id, title: p.title }, ...prev.filter((r) => r.id !== p.id)].slice(0, MAX_RECENT));
    setSearchOpen(false);
    setView('procedure');
  }, []);

  const goBack = useCallback(() => {
    setFocused(null);
    setView('directory');
  }, []);

  const handleProfileSaved = useCallback((p: VehicleProfile) => {
    setProfile(p);
    setProfileModalOpen(false);
    void loadDirectory(); // re-filter the tree for the newly saved build
  }, [loadDirectory]);

  // --- global shortcuts ---------------------------------------------------------
  const handleEscape = useCallback(() => {
    if (searchOpen) setSearchOpen(false);
    else if (profileModalOpen) setProfileModalOpen(false);
    else if (view !== 'directory') goBack();
  }, [searchOpen, profileModalOpen, view, goBack]);

  useGlobalShortcuts(
    { onCtrlEnter: () => setSearchOpen(true), onEscape: handleEscape },
    !splashDone,
  );

  const profileLabel = useMemo(() => {
    if (!profile) return 'Loading profile…';
    if (!profile.configured) return '⚙ Configure your build';
    return `${optionLabel(ENGINE_OPTIONS, profile.engine)} · ${optionLabel(TRANSMISSION_OPTIONS, profile.transmission)}`;
  }, [profile]);

  if (!splashDone) {
    return <SplashScreen onComplete={() => setSplashDone(true)} />;
  }

  // First-run: backend is up but no database has been loaded yet.
  if (health && !health.db_loaded) {
    return (
      <View style={styles.root}>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 }}>
          <Text style={{ fontSize: 48, marginBottom: 16 }}>🔧</Text>
          <Text style={{ ...typography.title, textAlign: 'center' }}>Welcome to WIS+</Text>
          <Text style={{ ...typography.body, color: colors.textSecondary, marginTop: 12, textAlign: 'center', maxWidth: 480 }}>
            No workshop database has been loaded yet. Copy your W201 knowledge-base
            SQLite file (e.g. w201_kb.sqlite) into the WIS+ data folder, then restart
            the app or press Reload.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => { void refreshHealth(); }}
            style={({ pressed }) => [
              { marginTop: 24, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8, backgroundColor: colors.accentPrimary },
              pressed && { opacity: 0.75 },
            ]}
          >
            <Text style={{ color: '#fff', fontWeight: '600' }}>⟳ Check Again</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const showBack = view !== 'directory';

  return (
    <View style={styles.root}>
      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <View style={styles.topBar}>
        {showBack && (
          <Pressable accessibilityRole="button" onPress={goBack} style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.7 }]}>
            <Text style={styles.backText}>← Back to Directory</Text>
          </Pressable>
        )}

        <View style={styles.brandWrap}>
          <Text style={[typography.brand, { color: colors.textPrimary }]}>WIS</Text>
          <Text style={[typography.brand, { color: colors.accentPrimary }]}>+</Text>
        </View>

        {/* Spotlight trigger — Ctrl + Enter */}
        <Pressable accessibilityRole="button" onPress={() => setSearchOpen(true)} style={({ pressed }) => [styles.searchTrigger, pressed && { opacity: 0.75 }]}>
          <Text style={styles.searchTriggerText}>🔍 Spotlight search</Text>
          <Kbd label="Ctrl" />
          <Kbd label="Enter" />
        </Pressable>

        {/* Source filter */}
        <View style={styles.segGroup}>
          {SOURCE_FILTERS.map((f) => (
            <Pressable
              key={f.value}
              accessibilityRole="button"
              onPress={() => setSourceFilter(f.value)}
              style={[styles.segBtn, sourceFilter === f.value && styles.segBtnActive]}
            >
              <Text style={[styles.segText, sourceFilter === f.value && styles.segTextActive]}>{f.label}</Text>
            </Pressable>
          ))}
        </View>

        {/* Vehicle profile pill — opens the quick selector */}
        <Pressable accessibilityRole="button" onPress={() => setProfileModalOpen(true)} style={({ pressed }) => [styles.pill, !profile?.configured && styles.pillUnset, pressed && { opacity: 0.75 }]}>
          <Text numberOfLines={1} style={[styles.pillText, !profile?.configured && { color: colors.accentAmber }]}>{profileLabel}</Text>
        </Pressable>

        {/* Toolbox grab list — combined spanner & special-tool checklist */}
        <Pressable accessibilityRole="button" onPress={() => setToolboxOpen(true)} style={({ pressed }) => [styles.toolboxBtn, pinnedJobs.length > 0 && styles.toolboxBtnActive, pressed && { opacity: 0.75 }]}>
          <Text style={[styles.toolboxText, pinnedJobs.length > 0 && { color: colors.accentAmber }]}>🧰 Toolbox ({pinnedJobs.length})</Text>
        </Pressable>

        {/* Settings */}
        <Pressable accessibilityRole="button" onPress={() => setView('settings')} style={({ pressed }) => [styles.gearBtn, view === 'settings' && styles.gearBtnActive, pressed && { opacity: 0.75 }]}>
          <Text style={[styles.gearText, view === 'settings' && { color: colors.textOnAmber }]}>⚙️ Settings</Text>
        </Pressable>
      </View>

      {/* ── Body: sidebar + routed view ─────────────────────────────────── */}
      <View style={styles.body}>
        <CategorySidebar
          categories={directory}
          loading={dirLoading}
          error={dirError}
          collapsed={view !== 'directory'}
          onOpenProcedure={openProcedure}
        />

        {view === 'directory' && (
          <Dashboard health={health} recent={recent} onOpenProcedure={openProcedure} />
        )}

        {view === 'procedure' && focused && (
          <View style={styles.flex1}>
            <ProcedureView id={focused.id} />
          </View>
        )}

        {view === 'settings' && (
          <View style={styles.flex1}>
            <SettingsView onBack={goBack} profile={profile} onProfileSaved={handleProfileSaved} />
          </View>
        )}
      </View>

      {/* ── Global layers ───────────────────────────────────────────────── */}
      <QuickSearch
        visible={searchOpen}
        onClose={() => setSearchOpen(false)}
        onOpenProcedure={openProcedure}
        engine={profile?.engine ?? undefined}
        transmission={profile?.transmission ?? undefined}
        source={sourceFilter === 'ALL' ? undefined : sourceFilter}
      />

      <ProfileModal
        visible={profileModalOpen}
        initialProfile={profile}
        onClose={() => setProfileModalOpen(false)}
        onSaved={handleProfileSaved}
      />

      <ToolboxDrawer open={toolboxOpen} onClose={() => setToolboxOpen(false)} />
    </View>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <ToolboxProvider>
        <AppShell />
      </ToolboxProvider>
    </ThemeProvider>
  );
}

// ---------------------------------------------------------------------------
// Styles — every color flows through tokens.ts so the theme engine can
// re-skin the shell without a reload.
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bgPrimary },
  body: { flex: 1, flexDirection: 'row' },
  flex1: { flex: 1 },

  // ── top bar ────────────────────────────────────────────────────────────
  topBar: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
    borderBottomWidth: 1, borderBottomColor: colors.borderSubtle, backgroundColor: colors.bgSurface,
  },
  backBtn: {
    height: 34, paddingHorizontal: spacing.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.borderHairline, backgroundColor: colors.bgElevated,
    alignItems: 'center', justifyContent: 'center',
  },
  backText: { ...typography.caption, color: colors.textSecondary },
  brandWrap: { flexDirection: 'row', alignItems: 'baseline' },

  searchTrigger: {
    flex: 1, height: 36, borderRadius: radius.md, marginHorizontal: spacing.xs,
    borderWidth: 1, borderColor: colors.borderHairline, backgroundColor: colors.bgPrimary,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs,
  },
  searchTriggerText: { ...typography.caption, color: colors.textMuted },

  kbd: {
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.sm,
    borderWidth: 1, borderColor: colors.borderHairline, backgroundColor: colors.bgElevated,
  },
  kbdText: { ...typography.caption, fontSize: 10, color: colors.textMuted },

  segGroup: {
    flexDirection: 'row', borderRadius: radius.md, overflow: 'hidden',
    borderWidth: 1, borderColor: colors.borderHairline, backgroundColor: colors.bgPrimary,
  },
  segBtn: { paddingHorizontal: spacing.md, paddingVertical: 8, alignItems: 'center', justifyContent: 'center' },
  segBtnActive: { backgroundColor: colors.accentDim },
  segText: { ...typography.caption, color: colors.textMuted },
  segTextActive: { color: colors.accentAmber, fontWeight: '700' },

  pill: {
    height: 34, paddingHorizontal: spacing.md, borderRadius: radius.pill,
    borderWidth: 1, borderColor: colors.borderHairline, backgroundColor: colors.bgElevated,
    alignItems: 'center', justifyContent: 'center', maxWidth: 260,
  },
  pillUnset: { borderColor: colors.accentAmber },
  pillText: { ...typography.caption, color: colors.textPrimary },

  toolboxBtn: {
    height: 34, paddingHorizontal: spacing.md, borderRadius: radius.pill,
    borderWidth: 1, borderColor: colors.borderHairline, backgroundColor: colors.bgElevated,
    alignItems: 'center', justifyContent: 'center',
  },
  toolboxBtnActive: { borderColor: colors.accentAmber },
  toolboxText: { ...typography.caption, fontWeight: '700' as const, color: colors.textSecondary },

  gearBtn: {
    height: 34, paddingHorizontal: spacing.md, borderRadius: radius.md,
    borderWidth: 1, borderColor: 'transparent', alignItems: 'center', justifyContent: 'center',
  },
  gearBtnActive: { backgroundColor: colors.accentDim, borderColor: colors.accentAmber },
  gearText: { ...typography.caption, color: colors.textSecondary },

  // ── dashboard (directory view, right pane) ─────────────────────────────
  dashRoot: { flex: 1, paddingHorizontal: spacing.xxl, paddingTop: spacing.xl, gap: spacing.lg },
  dashSub: { ...typography.body, color: colors.textMuted, marginTop: -6 },

  card: {
    backgroundColor: colors.bgSurface, borderRadius: radius.lg, borderWidth: 1,
    borderColor: colors.borderHairline, padding: spacing.lg, gap: spacing.sm,
  },
  cardLabel: { ...typography.sectionLabel, marginBottom: spacing.xs },

  statRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    backgroundColor: colors.bgElevated, borderRadius: radius.lg, borderWidth: 1,
    borderColor: colors.borderHairline, paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    minWidth: 120,
  },
  chipLabel: { ...typography.caption, color: colors.textMuted },
  chipValue: { ...typography.body, fontWeight: '600' },

  recentRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  recentTitle: { flex: 1, ...typography.body, color: colors.textPrimary },
  recentId: { ...typography.caption, color: colors.textMuted },
  emptyText: { ...typography.body, color: colors.textMuted },

  shortcutRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 2 },
  kbdGroup: { flexDirection: 'row', gap: 4, minWidth: 96, justifyContent: 'flex-end' },
  shortcutDesc: { flex: 1, ...typography.body, color: colors.textSecondary },
});
