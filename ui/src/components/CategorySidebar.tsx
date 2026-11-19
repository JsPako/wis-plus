/**
 * CategorySidebar — the collapsible left-hand index of the W201 procedure
 * directory (`GET /api/directory`).
 *
 * Multi-level accordion:  Category ("M102 Engine", "Suspension")
 *   → Subcategory ("1.8L", "Front Suspension", …)
 *     → Procedure leaves.
 *
 * Features per the WIS+ UX spec:
 *   • Smooth spring-animated chevrons on every expandable node,
 *   • Item-count badges (procedures per category / subcategory),
 *   • Source tags (`WIS` / `HAYNES`) — rendered whenever a node carries a
 *     `source` field (forward-compatible: the current directory payload is
 *     source-agnostic, so tags simply don't render until the backend emits
 *     them; no UI change needed then),
 *   • Focused Mode support: when `collapsed` flips true the whole panel
 *     animates to zero width and stops accepting pointer events.
 *
 * Clicking a procedure leaf calls `onOpenProcedure`, which the shell wires to
 * Focused Mode (sidebar collapses, "← Back to Directory" appears).
 */
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import type {
  DirectoryCategory,
  DirectorySubcategory,
  ManualSource,
} from '@/types/api';
import { colors, motion, radius, spacing, typography } from '@/theme/tokens';

const AnimView = Animated.View;

/** Full width of the expanded sidebar. */
export const SIDEBAR_WIDTH = 320;

/** A procedure leaf as handed to the shell when Focused Mode opens. */
export interface OpenedProcedureRef {
  id: number;
  title: string;
  category?: string;
  subcategory?: string;
}

interface CategorySidebarProps {
  /** Tree from `GET /api/directory`; null while unknown. */
  categories: DirectoryCategory[] | null;
  loading?: boolean;
  error?: string | null;
  /** Focused Mode — collapses the panel to zero width (animated). */
  collapsed?: boolean;
  onOpenProcedure: (procedure: OpenedProcedureRef) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Forward-compatible source lookup. The directory contract today carries no
 * per-node source; if the backend later tags categories/subcategories with
 * `{"source": "WIS" | "HAYNES"}` the tag renders automatically.
 */
function sourceOf(node: object): ManualSource | undefined {
  const s = (node as { source?: unknown }).source;
  return s === 'WIS' || s === 'HAYNES' ? s : undefined;
}

// ---------------------------------------------------------------------------
// Small atoms
// ---------------------------------------------------------------------------

/** Spring-animated chevron that rotates 0° → 90° as its node opens. */
function Chevron({ open }: { open: boolean }) {
  const rotation = useSharedValue(0);

  useEffect(() => {
    rotation.value = withTiming(
      open ? 90 : 0,
      { duration: motion.pressMs * 1.5, easing: Easing.out(Easing.cubic) },
    );
  }, [open, rotation]);

  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${rotation.value}deg` }] }));

  return (
    <AnimView style={style}>
      <Text style={styles.chevron}>›</Text>
    </AnimView>
  );
}

/** Procedure-count badge ("12", "3"). */
function CountBadge({ count }: { count: number }) {
  return (
    <View style={styles.countBadge}>
      <Text style={styles.countBadgeText}>{count}</Text>
    </View>
  );
}

/** `WIS` / `HAYNES` source tag pill. */
function SourceTag({ source }: { source: ManualSource }) {
  const isWis = source === 'WIS';
  return (
    <View style={[styles.sourceTag, { borderColor: isWis ? colors.accentAmber : colors.verifyGreen }]}>
      <Text style={[styles.sourceTagText, { color: isWis ? colors.accentAmber : colors.verifyGreen }]}>{source}</Text>
    </View>
  );
}

/**
 * Children container that fades/slides in when a node opens and unmounts
 * instantly on close (no exit animation — keeps layout collapse snappy and
 * avoids height-animation jank in the webview).
 */
function NodeChildren({ open, children }: { open: boolean; children: React.ReactNode }) {
  const opacity = useSharedValue(0);
  const translateY = useSharedValue(-6);

  useEffect(() => {
    if (open) {
      opacity.value = withTiming(1, { duration: motion.pressMs });
      translateY.value = withTiming(0, { duration: motion.pressMs, easing: Easing.out(Easing.cubic) });
    } else {
      opacity.value = 0;
      translateY.value = -6;
    }
  }, [open, opacity, translateY]);

  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  if (!open) return null;

  return <AnimView pointerEvents="box-none" style={style}>{children}</AnimView>;
}

// ---------------------------------------------------------------------------
// Tree nodes
// ---------------------------------------------------------------------------

function ProcedureLeaf({
  id,
  title,
  category,
  subcategory,
  onOpenProcedure,
}: {
  id: number;
  title: string;
  category: string;
  subcategory: string;
  onOpenProcedure: (p: OpenedProcedureRef) => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open procedure: ${title}`}
      onPress={() => onOpenProcedure({ id, title, category, subcategory })}
      style={({ pressed }) => [styles.leafRow, pressed && { backgroundColor: colors.bgElevated }]}
    >
      <View style={styles.leafDot} />
      <Text numberOfLines={2} style={styles.leafTitle}>{title}</Text>
    </Pressable>
  );
}

function SubcategoryNode({
  sub,
  category,
  onOpenProcedure,
}: {
  sub: DirectorySubcategory;
  category: string;
  onOpenProcedure: (p: OpenedProcedureRef) => void;
}) {
  const [open, setOpen] = useState(false);
  const source = sourceOf(sub);

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((o) => !o)}
        style={({ pressed }) => [styles.nodeRow, styles.subRow, pressed && { backgroundColor: colors.bgElevated }]}
      >
        <Chevron open={open} />
        <Text numberOfLines={1} style={styles.nodeName}>{sub.name}</Text>
        {source ? <SourceTag source={source} /> : null}
        <CountBadge count={sub.procedures.length} />
      </Pressable>

      <NodeChildren open={open}>
        {sub.procedures.map((p) => (
          <ProcedureLeaf key={p.id} id={p.id} title={p.title} category={category} subcategory={sub.name} onOpenProcedure={onOpenProcedure} />
        ))}
      </NodeChildren>
    </View>
  );
}

function CategoryNode({
  category,
  onOpenProcedure,
}: {
  category: DirectoryCategory;
  onOpenProcedure: (p: OpenedProcedureRef) => void;
}) {
  const [open, setOpen] = useState(false);
  const source = sourceOf(category);
  const count = useMemo(
    () => category.subcategories.reduce((n, s) => n + s.procedures.length, 0),
    [category],
  );

  return (
    <View style={styles.categoryBlock}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((o) => !o)}
        style={({ pressed }) => [styles.nodeRow, pressed && { backgroundColor: colors.bgElevated }]}
      >
        <Chevron open={open} />
        <Text numberOfLines={1} style={[styles.nodeName, typography.rowLabel]}>{category.category}</Text>
        {source ? <SourceTag source={source} /> : null}
        <CountBadge count={count} />
      </Pressable>

      <NodeChildren open={open}>
        {category.subcategories.map((sub) => (
          <SubcategoryNode key={`${category.category}/${sub.name}`} sub={sub} category={category.category} onOpenProcedure={onOpenProcedure} />
        ))}
      </NodeChildren>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Sidebar root
// ---------------------------------------------------------------------------

export default function CategorySidebar({
  categories,
  loading = false,
  error = null,
  collapsed = false,
  onOpenProcedure,
}: CategorySidebarProps) {
  const width = useSharedValue(collapsed ? 0 : SIDEBAR_WIDTH);

  useEffect(() => {
    width.value = withTiming(
      collapsed ? 0 : SIDEBAR_WIDTH,
      { duration: motion.modalInMs, easing: Easing.out(Easing.cubic) },
    );
  }, [collapsed, width]);

  const panelStyle = useAnimatedStyle(() => ({ width: width.value }));

  const totalProcedures = useMemo(
    () => categories?.reduce((n, c) => n + c.subcategories.reduce((m, s) => m + s.procedures.length, 0), 0) ?? 0,
    [categories],
  );

  return (
    <AnimView pointerEvents={collapsed ? 'none' : 'auto'} style={[styles.root, panelStyle]}>
      <ScrollView bounces={false} contentContainerStyle={styles.scrollContent}>
        <Text style={styles.sectionLabel}>Directory</Text>
        <Text style={styles.totalCaption}>{loading ? 'Loading…' : `${totalProcedures} procedures`}</Text>

        {error ? (
          <Text style={styles.errorText}>{error}</Text>
        ) : !loading && categories && categories.length === 0 ? (
          <Text style={styles.emptyText}>No procedures match the current build filter.</Text>
        ) : (
          (categories ?? []).map((c) => (
            <CategoryNode key={c.category} category={c} onOpenProcedure={onOpenProcedure} />
          ))
        )}
      </ScrollView>
    </AnimView>
  );
}

const styles = {
  root: {
    height: '100%' as const,
    backgroundColor: colors.bgSurface,
    borderRightWidth: 1,
    borderRightColor: colors.hairline,
    overflow: 'hidden' as const,
  },
  scrollContent: { padding: spacing.lg, paddingBottom: spacing.xxl },
  sectionLabel: { ...typography.sectionLabel, color: colors.textSecondary, marginBottom: spacing.xs },
  totalCaption: { ...typography.caption, color: colors.textSecondary, marginBottom: spacing.lg },
  errorText: { color: colors.dangerRed, ...typography.caption },
  emptyText: { color: colors.textSecondary, ...typography.body },

  categoryBlock: { marginBottom: spacing.sm },
  nodeRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    minHeight: 40,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
  },
  subRow: { paddingLeft: spacing.xl + spacing.sm },
  chevron: { color: colors.textSecondary, fontSize: 18, fontWeight: '700' as const, width: 22, textAlign: 'center' as const },
  nodeName: { flex: 1, ...typography.body, color: colors.textPrimary, marginLeft: spacing.xs },

  countBadge: {
    minWidth: 26,
    height: 20,
    borderRadius: radius.pill,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.hairline,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    paddingHorizontal: spacing.sm,
    marginLeft: spacing.sm,
  },
  countBadgeText: { fontSize: 11, fontWeight: '700' as const, color: colors.textSecondary },

  sourceTag: {
    height: 20,
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: spacing.sm + 2,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    marginLeft: spacing.sm,
  },
  sourceTagText: { fontSize: 10, fontWeight: '800' as const, letterSpacing: 0.8 },

  leafRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    minHeight: 34,
    paddingLeft: spacing.xl + spacing.lg,
    paddingRight: spacing.md,
    borderRadius: radius.sm,
  },
  leafDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.accentAmber,
    opacity: 0.75,
    marginRight: spacing.md,
  },
  leafTitle: { flex: 1, ...typography.caption, color: colors.textPrimary },
};
