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
import ProfileModal from '@/components/ProfileModal';
import SplashScreen from '@/components/SplashScreen';
import {
  ENGINE_OPTIONS,
  TRANSMISSION_OPTIONS,
  optionLabel,
  type HealthResponse,
  type VehicleProfile,
} from '@/types/api';
import { colors, radius, spacing, typography } from '@/theme/tokens';

export default function App() {
  const [splashDone, setSplashDone] = useState(false);
  const [profile, setProfile] = useState<VehicleProfile | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

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

  const handleSplashComplete = useCallback(() => setSplashDone(true), []);
  const handleProfileSaved = useCallback((p: VehicleProfile) => {
    setProfile(p);
    setModalOpen(false);
  }, []);

  const badgeLabel = useMemo(() => {
    if (!profile?.configured) return 'Select your car';
    return `${optionLabel(ENGINE_OPTIONS, profile.engine)} · ${optionLabel(TRANSMISSION_OPTIONS, profile.transmission)}`;
  }, [profile]);

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

      {/* Body (search + directory land in Task 6) ------------------------- */}
      <View style={styles.body}>
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
          Spotlight search and the collapsible procedure directory arrive in Task 6.
        </Text>
      </View>

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
  body: { flex: 1 as const, alignItems: 'center' as const, justifyContent: 'center' as const, padding: spacing.xxl },
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
