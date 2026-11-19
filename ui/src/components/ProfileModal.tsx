/**
 * ProfileModal — user-selectable vehicle profile.
 *
 * WIS+ never assumes the user's car. Opens when `/api/profile` reports
 * `configured === false`, or whenever the user taps the top-bar Vehicle
 * Profile badge. Lets the builder pick an Engine and a Transmission variant,
 * then persists via POST /api/profile.
 */

import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { api, ApiError } from '@/api/client';
import {
  ENGINE_OPTIONS,
  TRANSMISSION_OPTIONS,
  type ProfileOption,
  type VehicleProfile,
} from '@/types/api';
import { colors, motion, radius, spacing, typography } from '@/theme/tokens';

const AnimView = Animated.View;

interface ProfileModalProps {
  visible: boolean;
  /** Current profile (used to preselect); null when nothing is known yet. */
  initialProfile: VehicleProfile | null;
  onClose: () => void;
  onSaved: (profile: VehicleProfile) => void;
}

// ---------------------------------------------------------------------------
// One tactile option row: amber indicator bar + label, elevated when selected.
// ---------------------------------------------------------------------------
function OptionRow({
  option,
  selected,
  onPress,
}: {
  option: ProfileOption;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.optionRow,
        selected && styles.optionRowSelected,
        pressed && { opacity: 0.85 },
      ]}
    >
      <View style={[styles.indicator, selected && styles.indicatorActive]} />
      <Text
        numberOfLines={1}
        style={[styles.optionLabel, { color: selected ? colors.textPrimary : colors.textSecondary }]}
      >
        {option.label}
      </Text>
      {selected ? <Text style={styles.checkMark}>✓</Text> : null}
    </Pressable>
  );
}

export default function ProfileModal({ visible, initialProfile, onClose, onSaved }: ProfileModalProps) {
  const [engine, setEngine] = useState<string>(initialProfile?.engine ?? 'ALL');
  const [transmission, setTransmission] = useState<string>(initialProfile?.transmission ?? 'ALL');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-sync selections every time the modal opens.
  useEffect(() => {
    if (visible) {
      setEngine(initialProfile?.engine ?? 'ALL');
      setTransmission(initialProfile?.transmission ?? 'ALL');
      setError(null);
      setSaving(false);
    }
  }, [visible, initialProfile]);

  // --- open/close choreography ---------------------------------------------
  const scrimOpacity = useSharedValue(0);
  const panelScale = useSharedValue(visible ? 1 : 0.96);
  useEffect(() => {
    if (visible) {
      scrimOpacity.value = withTiming(1, { duration: motion.modalInMs });
      panelScale.value = withTiming(1, { duration: motion.modalInMs, easing: Easing.out(Easing.cubic) });
    } else {
      scrimOpacity.value = withTiming(0, { duration: motion.modalInMs });
      panelScale.value = withTiming(0.96, { duration: motion.modalInMs });
    }
  }, [visible]);

  const scrimStyle = useAnimatedStyle(() => ({ opacity: scrimOpacity.value }));
  const panelStyle = useAnimatedStyle(() => ({ transform: [{ scale: panelScale.value }] }));

  if (!visible) return null;

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const saved = await api.saveProfile({ engine, transmission });
      onSaved(saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save profile.');
      setSaving(false);
    }
  };

  return (
    <AnimView style={[styles.scrim, scrimStyle]} pointerEvents="box-none">
      <Pressable style={styles.backdrop} onPress={onClose} />
      <AnimView style={[styles.panel, panelStyle]}>
        <ScrollView bounces={false} contentContainerStyle={styles.scrollContent}>
          <Text style={styles.title}>Vehicle Profile</Text>
          <Text style={styles.subtitle}>
            Tell WIS+ which 190E you're working on — nothing is assumed until you choose.
          </Text>

          <Text style={styles.sectionLabel}>Engine</Text>
          {ENGINE_OPTIONS.map((opt) => (
            <OptionRow key={opt.value} option={opt} selected={engine === opt.value} onPress={() => setEngine(opt.value)} />
          ))}

          <Text style={[styles.sectionLabel, { marginTop: spacing.xl }]}>Transmission</Text>
          {TRANSMISSION_OPTIONS.map((opt) => (
            <OptionRow key={opt.value} option={opt} selected={transmission === opt.value} onPress={() => setTransmission(opt.value)} />
          ))}

          {error ? <Text style={styles.error}>{error}</Text> : null}
        </ScrollView>

        <View style={styles.footer}>
          <Pressable accessibilityRole="button" onPress={onClose} style={({ pressed }) => [styles.cancelBtn, pressed && { opacity: 0.7 }]}>
            <Text style={styles.cancelLabel}>Cancel</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={saving}
            onPress={() => void handleSave()}
            style={({ pressed }) => [styles.saveBtn, (saving || pressed) && { opacity: 0.8 }]}
          >
            <Text style={styles.saveLabel}>{saving ? 'Saving…' : 'Save Profile'}</Text>
          </Pressable>
        </View>
      </AnimView>
    </AnimView>
  );
}

const styles = {
  scrim: {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.scrim,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    zIndex: 100,
  },
  backdrop: { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0 },
  panel: {
    width: 580,
    maxWidth: '92%' as const,
    maxHeight: '92%' as const,
    backgroundColor: colors.bgSurface,
    borderColor: colors.hairlineStrong,
    borderWidth: 1,
    borderRadius: radius.lg,
  },
  scrollContent: { padding: spacing.xl },
  title: { fontSize: 22, fontWeight: '800' as const, color: colors.textPrimary, marginBottom: spacing.xs },
  subtitle: { ...typography.caption, color: colors.textSecondary, marginBottom: spacing.lg },
  sectionLabel: { ...typography.sectionLabel, color: colors.textSecondary, marginBottom: spacing.md },
  optionRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    height: 46,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: 'transparent',
    marginBottom: spacing.sm,
  },
  optionRowSelected: { backgroundColor: colors.bgElevated, borderColor: colors.accentAmber },
  indicator: {
    width: 3,
    height: 22,
    borderRadius: radius.pill,
    backgroundColor: 'transparent',
    marginRight: spacing.md,
  },
  indicatorActive: { backgroundColor: colors.accentAmber },
  optionLabel: { ...typography.rowLabel, flex: 1 },
  checkMark: { color: colors.accentAmber, fontSize: 16, fontWeight: '700' as const },
  error: { color: colors.dangerRed, ...typography.caption, marginTop: spacing.sm },
  footer: {
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const,
    margin: spacing.xl,
    marginTop: 0,
    paddingTop: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.hairline,
  },
  cancelBtn: { paddingVertical: spacing.md, paddingHorizontal: spacing.lg },
  cancelLabel: { color: colors.textSecondary, fontWeight: '600' as const, fontSize: 15 },
  saveBtn: {
    backgroundColor: colors.accentAmber,
    borderRadius: radius.md,
    paddingVertical: spacing.md - 2,
    paddingHorizontal: spacing.xl,
  },
  saveLabel: { color: colors.textOnAmber, fontWeight: '800' as const, fontSize: 15, letterSpacing: 0.4 },
};
