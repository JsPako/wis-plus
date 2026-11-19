/**
 * WIS+ root component.
 *
 * Boot sequence: animated SplashScreen (WIS fade-in + amber "+" slide) until
 * `/api/health` responds, then the main shell — top bar with the Vehicle
 * Profile badge and the workshop body. If the backend reports
 * `configured === false`, the ProfileModal opens automatically; the user is
 * never assumed a car.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { api } from '@/api/client';
import CategorySidebar from '@/components/CategorySidebar';
import ProfileModal from '@/components/ProfileModal';
import QuickSearch from '@/components/QuickSearch';
import SplashScreen from '@/components/SplashScreen';
import ProcedureView from '@/screens/ProcedureView';
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

export default function App() {
  const [splashDone, setSplashDone] = useState(false);
  const [profile, setProfile] = useState<VehicleProfile | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  // Task 6 — directory tree, Spotlight search, Focused Mode.
  const [directory, setDirectory] = useState<DirectoryCategory[] | null>(null);
  const [dirLoading, setDirLoading] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [focused, setFocused] = useState<{ id: number; title: string } | null>(null);

  // After the splash: load profile + health. Auto-open the modal when the
  // user has never configured their car.
  useEffect(() => {
    if (!splashDone) return;
    let cancelled = false;
    void api
      .getProfile()
      .then((p) => {
        if (cancelled) return;
        setProfile(p);
        if (!p.configured) setModalOpen(true);
      })
      .catch(() => undefined); // backend offline — badge shows 'select'
    void api
      .health()
      .then((h) => !cancelled && setHealth(h))
      .catch(() => !cancelled && setHealth(null));
    return () => {
      cancelled = true;
    };
  }, [splashDone]);

  // Directory tree — refetches whenever the active build profile changes.
  useEffect(() => {
    if (!splashDone) return;
    let cancelled = false;
    setDirLoading(true);
    setDirError(null);
    void api
      .directory(profile?.engine, profile?.transmission)
      .then((tree) => !cancelled && setDirectory(tree))
      .catch(() => !cancelled && setDirError('Failed to load the directory.'))
      .finally(() => !cancelled && setDirLoading(false));
    return () => {
      cancelled = true;
    };
  }, [splashDone, profile]);

  const handleSplashComplete = useCallback(() => setSplashDone(true), []);
  const handleProfileSaved = useCallback((p: VehicleProfile) => {
    setProfile(p);
    setModalOpen(false);
  }, []);

  const badgeLabel = useMemo(() => {
    if (!profile?.configured) return 'Select your car';
    return `${optionLabel(ENGINE_OPTIONS, profile.engine)} · ${optionLabel(TRANSMISSION_OPTIONS, profile.transmission)}`;
  }, [profile]);

  // Global shortcuts: Ctrl+Enter toggles Spotlight; Escape unwinds the topmost layer.
  useGlobalShortcuts({
    onCtrlEnter: () => setSearchOpen((open) => !open),
    onEscape: () => {
      if (searchOpen) setSearchOpen(false);
      else if (modalOpen) setModalOpen(false);
      else if (focused !== null) setFocused(null); // back to the directory
    },
  });

  const openProcedure = useCallback((procedure: { id: number; title: string }) => {
    setFocused({ id: procedure.id, title: procedure.title });
    setSearchOpen(false);
  }, []);

  if (!splashDone) {
    return <SplashScreen onComplete={handleSplashComplete} />;
  }

  const backendOnline = health?.status === 'ok' && health.db_loaded;

  return (
    <View style={styles.root}>
      {/* Top bar ---------------------------------------------------------- */}
      <View style={styles.topBar}>
        <View style={styles.brandRow}>
          <Text style={styles.brand}>WIS</Text>
          <Text style={styles.brandPlus}>+</Text>
        </View>
        <View style={styles.topBarRight}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open quick search (Ctrl plus Enter)"
          onPress={() => setSearchOpen(true)}
          style={({ pressed }) => [styles.searchTrigger, pressed && { opacity: 0.85 }]}
        >
          <Text style={styles.searchIcon}>⌕</Text>
          <Text numberOfLines={1} style={styles.searchLabel}>Search…</Text>
          <View style={styles.kbdBadge}>
            <Text style={styles.kbdText}>Ctrl + Enter</Text>
          </View>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => setModalOpen(true)}
          style={({ pressed }) => [styles.badge, !profile?.configured && styles.badgeUnset, pressed && { opacity: 0.85 }]}
        >
          <View style={[styles.badgeDot, !profile?.configured && { backgroundColor: colors.accentAmber }]} />
          <Text numberOfLines={1} style={[styles.badgeLabel, !profile?.configured && { color: colors.accentAmber }]}>
            {badgeLabel}
          </Text>
          <Text style={styles.badgeChevron}>›</Text>
        </Pressable>
        </View>
      </View>

      {/* Body — directory sidebar + Focused Mode content ------------------ */}
      <View style={styles.bodyRow}>
        <CategorySidebar
          categories={directory}
          loading={dirLoading}
          error={dirError}
          collapsed={focused !== null}
          onOpenProcedure={openProcedure}
        />
        <View style={styles.contentArea}>
          {focused !== null ? (
            <>
              <Pressable
                accessibilityRole="button"
                onPress={() => setFocused(null)}
                style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.85 }]}
              >
                <Text style={styles.backText}>← Back to Directory</Text>
              </Pressable>
              {/* Task 7 — split-screen workspace: extracted procedure (52%) +
                  original PDF verification pane (48%). */}
              <ProcedureView key={focused.id} id={focused.id} />
            </>
          ) : (
            <View style={styles.placeholderWrap}>
              <View style={styles.statusRow}>
                <View style={[styles.statusDot, { backgroundColor: backendOnline ? colors.verifyGreen : colors.dangerRed }]} />
                <Text style={styles.statusText}>
                  {backendOnline
                    ? `Backend online — ${health?.procedure_count ?? 0} procedures indexed`
                    : 'Backend offline — start the sidecar (python -m backend.main)'}
                </Text>
              </View>
              <Text style={styles.placeholderTitle}>Workshop ready.</Text>
              <Text style={styles.placeholderBody}>
                Pick a procedure from the directory, or press Ctrl + Enter for Spotlight search.
              </Text>
            </View>
          )}
        </View>
      </View>

      <QuickSearch
        visible={searchOpen}
        onClose={() => setSearchOpen(false)}
        onOpenProcedure={openProcedure}
        engine={profile?.engine}
        transmission={profile?.transmission}
      />

      <ProfileModal
        visible={modalOpen}
        initialProfile={profile}
        onClose={() => setModalOpen(false)}
        onSaved={handleProfileSaved}
      />
    </View>
  );
}

const styles = {
  root: { flex: 1 as const, backgroundColor: colors.bgPrimary },
  topBar: {
    height: 56,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    paddingHorizontal: spacing.xl,
    backgroundColor: colors.bgSurface,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
  brandRow: { flexDirection: 'row' as const, alignItems: 'baseline' as const },
  brand: { fontSize: 24, fontWeight: '800' as const, letterSpacing: 1.5, color: colors.textPrimary },
  brandPlus: { fontSize: 26, fontWeight: '700' as const, color: colors.accentAmber },
  badge: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    height: 38,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.hairlineStrong,
    maxWidth: 420,
  },
  badgeUnset: { borderColor: colors.accentAmber },
  badgeDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.verifyGreen, marginRight: spacing.sm },
  badgeLabel: { ...typography.rowLabel, flexShrink: 1 as const, color: colors.textPrimary },
  badgeChevron: { color: colors.textSecondary, fontSize: 18, marginLeft: spacing.sm },
  topBarRight: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing.md },
  searchTrigger: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    height: 38,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.hairlineStrong,
  },
  searchIcon: { fontSize: 16, color: colors.textSecondary, marginRight: spacing.sm },
  searchLabel: { ...typography.rowLabel, color: colors.textSecondary, marginRight: spacing.sm },
  kbdBadge: {
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 2,
    borderRadius: radius.xs,
    borderWidth: 1,
    borderColor: colors.hairlineStrong,
    backgroundColor: colors.bgPrimary,
  },
  kbdText: { fontSize: 10, fontWeight: '700' as const, color: colors.textSecondary },
  bodyRow: { flex: 1 as const, flexDirection: 'row' as const },
  contentArea: { flex: 1 as const },
  placeholderWrap: { flex: 1 as const, alignItems: 'center' as const, justifyContent: 'center' as const, padding: spacing.xxl },
  backBtn: {
    alignSelf: 'flex-start' as const,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.hairlineStrong,
    marginBottom: spacing.xl,
  },
  backText: { ...typography.rowLabel, color: colors.accentAmber },
  statusRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    backgroundColor: colors.bgSurface,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    marginBottom: spacing.xxl,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: spacing.sm },
  statusText: { ...typography.caption, color: colors.textSecondary },
  placeholderTitle: { fontSize: 28, fontWeight: '800' as const, color: colors.textPrimary, marginBottom: spacing.md },
  placeholderBody: { ...typography.body, color: colors.textSecondary },
};
