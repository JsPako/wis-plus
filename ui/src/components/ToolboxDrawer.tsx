/**
 * ToolboxDrawer — the slide-over "Toolbox Grab List" (Task 9).
 *
 * Opened from the `🧰 Toolbox (N)` pill in the top header bar. Shows:
 *   • pinned procedures as removable chips,
 *   • Mercedes-Benz special tools (signal amber, order by part code),
 *   • metric spanners / sockets / drivers sorted naturally by mm size,
 *   • per-tool "required by" job titles + checkable rows,
 *   • Reset Checkboxes / Clear Jobs actions.
 *
 * Motion: Reanimated v3 slide-in from the right (translateX 100% → 0) with a
 * scrim fade — same physics constants as the rest of the shell (`motion`).
 */

import { useEffect, useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { useTheme } from '@/theme/ThemeContext';
import { colors, motion, radius, spacing, typography } from '@/theme/tokens';
import {
  useToolbox,
  type MergedTool,
} from '@/state/ToolboxContext';

const AnimView = Animated.View;

interface ToolboxDrawerProps {
  open: boolean;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function JobChip({ title, onRemove }: { title: string; onRemove: () => void }) {
  return (
    <View style={styles.jobChip}>
      <Text numberOfLines={1} style={styles.jobChipTitle}>{title}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Unpin ${title} from the toolbox`}
        onPress={onRemove}
        hitSlop={6}
        style={({ pressed }) => [styles.jobChipX, pressed && { opacity: 0.6 }]}
      >
        <Text style={styles.jobChipXText}>✕</Text>
      </Pressable>
    </View>
  );
}

function ToolRow({ tool }: { tool: MergedTool }) {
  const { checkedTools, toggleToolChecked } = useToolbox();
  const done = checkedTools.has(tool.key);
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={`${tool.name}${tool.sizeOrCode ? ` · ${tool.sizeOrCode}` : ''} — required by ${tool.requiredBy.join(', ')}`}
      onPress={() => toggleToolChecked(tool.key)}
      style={({ pressed }) => [styles.toolRow, tool.isSpecial && styles.toolRowSpecial, done && styles.toolRowDone, pressed && { opacity: 0.85 }]}
    >
      <View style={[styles.toolCheck, done && styles.toolCheckDone, tool.isSpecial && !done && styles.toolCheckSpecial]}>
        <Text style={[styles.toolCheckTick, !done && { color: 'transparent' }]}>✓</Text>
      </View>
      <View style={styles.toolBody}>
        <Text numberOfLines={2} style={[styles.toolName, done && styles.toolNameDone, tool.isSpecial && styles.toolNameSpecial]}>
          {tool.name}{tool.sizeOrCode ? ` · ${tool.sizeOrCode}` : ''}
        </Text>
        <Text numberOfLines={1} style={styles.toolBy}>for: {tool.requiredBy.join(' + ')}</Text>
      </View>
    </Pressable>
  );
}

function SectionHeader({ label, count, special }: { label: string; count: number; special?: boolean }) {
  return (
    <View style={styles.sectionRow}>
      <Text style={[styles.sectionLabel, special && styles.sectionLabelSpecial]}>{label}</Text>
      <Text style={[styles.sectionCount, special && styles.sectionCountSpecial]}>{count}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------
export default function ToolboxDrawer({ open, onClose }: ToolboxDrawerProps) {
  const { theme } = useTheme();
  const { pinnedJobs, togglePinJob, clearAllJobs, checkedTools, resetChecked, mergedTools } = useToolbox();

  // Slide-in from the right: tx goes 1 (hidden) → 0 (open). Percent-based so it
  // tracks the panel width on any viewport.
  const tx = useSharedValue(1);
  const scrimOpacity = useSharedValue(0);

  useEffect(() => {
    if (open) {
      tx.value = withTiming(0, { duration: motion.modalInMs, easing: Easing.out(Easing.cubic) });
      scrimOpacity.value = withTiming(1, { duration: motion.modalInMs });
    } else {
      tx.value = withTiming(1, { duration: motion.modalInMs });
      scrimOpacity.value = withTiming(0, { duration: motion.modalInMs });
    }
  }, [open, tx, scrimOpacity]);

  const panelStyle = useAnimatedStyle(() => ({ transform: [{ translateX: `${tx.value * 100}%` }] }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: scrimOpacity.value }));

  const checkedCount = useMemo(
    () => mergedTools.total - [...checkedTools].filter((k) => !mergedTools.standard.concat(mergedTools.special).some((t) => t.key === k)).length,
    [checkedTools, mergedTools],
  );

  return (
    <AnimView style={[styles.scrim, scrimStyle]} pointerEvents="box-none">
      <Pressable accessibilityRole="button" accessibilityLabel="Close toolbox" onPress={onClose} style={styles.scrimHit} />

      <AnimView style={[styles.panel, panelStyle]}>
        {/* Header ----------------------------------------------------------- */}
        <View style={styles.header}>
          <View style={styles.headerTexts}>
            <Text style={styles.title}>🧰 Toolbox Grab List</Text>
            <Text style={styles.subtitle}>
              {mergedTools.total > 0
                ? `${checkedCount}/${mergedTools.total} tools grabbed`
                : 'Pin procedures to build your grab list'}
            </Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Close toolbox" onPress={onClose} hitSlop={8} style={({ pressed }) => [styles.closeBtn, pressed && { opacity: 0.7 }]}>
            <Text style={styles.closeText}>✕</Text>
          </Pressable>
        </View>

        {/* Pinned job chips --------------------------------------------------- */}
        {pinnedJobs.length > 0 ? (
          <View style={styles.chipRow}>
            {pinnedJobs.map((job) => (
              <JobChip key={job.procedureId} title={job.title} onRemove={() => togglePinJob({ id: job.procedureId, title: job.title, tools: job.tools })} />
            ))}
          </View>
        ) : null}

        {/* Checklist ---------------------------------------------------------- */}
        {mergedTools.total === 0 ? (
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyIcon}>🧰</Text>
            <Text style={styles.emptyTitle}>No jobs pinned yet</Text>
            <Text style={styles.emptyBody}>
              Open a procedure and tap “+ Pin Tools to Toolbox” — every spanner, socket and special tool from all pinned jobs lands here, deduplicated.
            </Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
            {mergedTools.special.length > 0 ? (
              <View style={styles.section}>
                <SectionHeader label="★ Mercedes-Benz Special Tools" count={mergedTools.special.length} special />
                {mergedTools.special.map((tool) => (<ToolRow key={tool.key} tool={tool} />))}
              </View>
            ) : null}

            {mergedTools.standard.length > 0 ? (
              <View style={styles.section}>
                <SectionHeader label="Metric Spanners, Sockets & Drivers" count={mergedTools.standard.length} />
                {mergedTools.standard.map((tool) => (<ToolRow key={tool.key} tool={tool} />))}
              </View>
            ) : null}
          </ScrollView>
        )}

        {/* Footer actions ------------------------------------------------------ */}
        <View style={styles.footer}>
          <Pressable
            accessibilityRole="button"
            onPress={resetChecked}
            disabled={mergedTools.total === 0}
            style={({ pressed }) => [styles.footerBtn, mergedTools.total === 0 && styles.footerBtnDisabled, pressed && { opacity: 0.8 }]}
          >
            <Text style={styles.footerBtnText}>Reset Checkboxes</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={clearAllJobs}
            disabled={pinnedJobs.length === 0}
            style={({ pressed }) => [styles.footerBtnDanger, pinnedJobs.length === 0 && styles.footerBtnDisabled, pressed && { opacity: 0.8 }]}
          >
            <Text style={styles.footerBtnDangerText}>Clear Jobs</Text>
          </Pressable>
        </View>

        <Text style={styles.themeFoot}>{theme.name} · {pinnedJobs.length} job{pinnedJobs.length === 1 ? '' : 's'} pinned</Text>
      </AnimView>
    </AnimView>
  );
}

// ---------------------------------------------------------------------------
// Styles — tokens only
// ---------------------------------------------------------------------------
const styles = StyleSheet.create({
  scrim: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 60,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    backgroundColor: colors.scrim,
  },
  scrimHit: { flex: 1 },

  panel: {
    width: 420,
    maxWidth: '92%',
    height: '100%',
    backgroundColor: colors.bgSurface,
    borderLeftWidth: 1,
    borderLeftColor: colors.borderSubtle,
    flexDirection: 'column',
  },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  headerTexts: { flexShrink: 1 },
  title: { ...typography.title, color: colors.textPrimary },
  subtitle: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  closeBtn: {
    width: 30, height: 30, borderRadius: radius.pill,
    backgroundColor: colors.bgElevated, borderWidth: 1, borderColor: colors.borderSubtle,
    alignItems: 'center', justifyContent: 'center',
  },
  closeText: { fontSize: 14, fontWeight: '700' as const, color: colors.textSecondary },

  chipRow: {
    flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm,
    paddingHorizontal: spacing.xl, paddingVertical: spacing.md,
    borderBottomWidth: 1, borderBottomColor: colors.borderSubtle,
  },
  jobChip: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.xs,
    backgroundColor: colors.bgElevated, borderRadius: radius.pill,
    borderWidth: 1, borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.sm + 2, paddingVertical: 5, maxWidth: 300,
  },
  jobChipTitle: { ...typography.caption, fontWeight: '600', color: colors.textPrimary },
  jobChipX: { padding: 2 },
  jobChipXText: { fontSize: 11, fontWeight: '700', color: colors.textMuted },

  scrollContent: { flex: 1, paddingHorizontal: spacing.xl, paddingTop: spacing.lg, paddingBottom: spacing.lg },

  section: { marginBottom: spacing.xl },
  sectionRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  sectionLabel: { ...typography.sectionLabel, color: colors.textSecondary },
  sectionLabelSpecial: { color: colors.accentAmber },
  sectionCount: { ...typography.caption, fontWeight: '700', color: colors.textMuted },
  sectionCountSpecial: { color: colors.accentAmber },

  toolRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    backgroundColor: colors.bgElevated, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.borderSubtle,
    padding: spacing.md, marginBottom: spacing.sm,
  },
  toolRowSpecial: { backgroundColor: colors.amberDim, borderColor: colors.accentAmber },
  toolRowDone: { opacity: 0.62 },
  toolCheck: {
    width: 24, height: 24, borderRadius: radius.sm, borderWidth: 2,
    borderColor: colors.borderSubtle, backgroundColor: colors.bgPrimary,
    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  toolCheckSpecial: { borderColor: colors.accentAmber },
  toolCheckDone: { backgroundColor: colors.verifyGreen, borderColor: colors.verifyGreen },
  toolCheckTick: { fontSize: 14, fontWeight: '800', color: colors.textPrimary },
  toolBody: { flexShrink: 1 },
  toolName: { ...typography.rowLabel, color: colors.textPrimary },
  toolNameSpecial: { color: colors.accentAmber },
  toolNameDone: { textDecorationLine: 'line-through', color: colors.textSecondary },
  toolBy: { ...typography.caption, color: colors.textMuted, marginTop: 2 },

  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.sm },
  emptyIcon: { fontSize: 40 },
  emptyTitle: { ...typography.heading, color: colors.textPrimary },
  emptyBody: { ...typography.caption, color: colors.textSecondary, textAlign: 'center', maxWidth: 300 },

  footer: {
    flexDirection: 'row', gap: spacing.sm,
    paddingHorizontal: spacing.xl, paddingVertical: spacing.md,
    borderTopWidth: 1, borderTopColor: colors.borderSubtle,
  },
  footerBtn: {
    flex: 1, height: 36, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.bgElevated, borderWidth: 1, borderColor: colors.borderSubtle,
  },
  footerBtnText: { ...typography.caption, fontWeight: '700', color: colors.textPrimary },
  footerBtnDanger: {
    flex: 1, height: 36, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.dangerRed,
  },
  footerBtnDangerText: { ...typography.caption, fontWeight: '700', color: colors.dangerRed },
  footerBtnDisabled: { opacity: 0.45 },

  themeFoot: {
    ...typography.caption, fontSize: 11, color: colors.textMuted, textAlign: 'center',
    paddingBottom: spacing.sm,
  },
});
