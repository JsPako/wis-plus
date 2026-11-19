/**
 * QuickSearch — Apple Spotlight-style global procedure search for WIS+.
 *
 * Trigger:
 *   • Globally via **Ctrl+Enter** anywhere in the app (see
 *     `useGlobalShortcuts`), or by clicking the search trigger in the top bar.
 *   • Renders a centered floating modal: `width: '90%'`, `maxWidth: 680`, an
 *     elevated `#1B1F24` (colors.bgSurface) card with the signal-amber focus
 *     border, over a dimmed + blurred backdrop.
 *
 * Live instant results:
 *   • Every keystroke is debounced (120 ms) into `GET /api/search`, honoring
 *     the active vehicle profile (engine/transmission filters).
 *   • Each row shows the matched synonym chips ("Matched alias: strut,
 *     damper"), the category breadcrumb, a torque preview pill, and the
 *     manual source badge (`WIS` / `HAYNES` — rendered when the backend tags
 *     a result with `source`; forward-compatible, same convention as the
 *     directory sidebar).
 *
 * Full keyboard & mouse navigation (window-level listener so it works
 * identically in Tauri's WebView2 on Windows and WebKitGTK on Linux):
 *   • ArrowDown / Tab        → move selection down (wraps)
 *   • ArrowUp / Shift+Tab    → move selection up (wraps)
 *   • Enter / row click      → open the procedure in Focused Mode, close modal
 *   • Escape / backdrop click → close the modal
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { api, ApiError } from '@/api/client';
import type { ManualSource, SearchResultItem } from '@/types/api';
import { colors, motion, radius, spacing, typography } from '@/theme/tokens';

const AnimView = Animated.View;

/** Debounce window for the live search requests. */
const DEBOUNCE_MS = 120;
/** How many results the Spotlight list shows. */
const RESULT_LIMIT = 8;
/** Ignore a second "open" within this window (Enter can fire twice). */
const OPEN_GUARD_MS = 250;

export interface QuickSearchOpenRef {
  id: number;
  title: string;
}

interface QuickSearchProps {
  visible: boolean;
  onClose: () => void;
  /** Called with the chosen procedure; the shell opens Focused Mode. */
  onOpenProcedure: (procedure: QuickSearchOpenRef) => void;
  /** Active build filters forwarded to `/api/search`. */
  engine?: string;
  transmission?: string;
  /** Manual source filter forwarded to `/api/search` (undefined = All). */
  source?: 'WIS' | 'HAYNES';
}

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

/** Small `<kbd>`-style badge, e.g. "Ctrl + Enter". */
function Kbd({ label }: { label: string }) {
  return (
    <View style={styles.kbd}>
      <Text style={styles.kbdText}>{label}</Text>
    </View>
  );
}

/** `WIS` / `HAYNES` badge — same forward-compatible convention as sidebar. */
function SourceBadge({ source }: { source: ManualSource }) {
  const isWis = source === 'WIS';
  return (
    <View style={[styles.sourceBadge, { borderColor: isWis ? colors.accentAmber : colors.verifyGreen }]}>
      <Text style={[styles.sourceBadgeText, { color: isWis ? colors.accentAmber : colors.verifyGreen }]}>{source}</Text>
    </View>
  );
}

function sourceOf(node: object): ManualSource | undefined {
  const s = (node as { source?: unknown }).source;
  return s === 'WIS' || s === 'HAYNES' ? s : undefined;
}

// ---------------------------------------------------------------------------
// Result row
// ---------------------------------------------------------------------------

function ResultRow({
  item,
  selected,
  onOpen,
}: {
  item: SearchResultItem;
  selected: boolean;
  onOpen: () => void;
}) {
  const source = sourceOf(item);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onOpen}
      style={({ pressed }) => [
        styles.resultRow,
        selected && styles.resultRowSelected,
        pressed && !selected && { backgroundColor: colors.bgElevated },
      ]}
    >
      <View style={[styles.rowIndicator, selected && { backgroundColor: colors.accentAmber }]} />
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={styles.resultTitle}>{item.title}</Text>
        <Text numberOfLines={1} style={styles.resultBreadcrumb}>
          {item.category} › {item.subcategory}
        </Text>
        {item.snippet ? (
          <Text numberOfLines={1} style={styles.resultSnippet}>{item.snippet}</Text>
        ) : null}
      </View>

      <View style={styles.resultMeta}>
        {item.torque_count > 0 ? (
          <View style={styles.torquePill}>
            <Text style={styles.torquePillText}>⚙ {item.torque_count} torque</Text>
          </View>
        ) : null}
        {source ? <SourceBadge source={source} /> : null}
      </View>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// QuickSearch root
// ---------------------------------------------------------------------------

export default function QuickSearch({ visible, onClose, onOpenProcedure, engine, transmission, source }: QuickSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResultItem[] | null>(null);
  const [synonyms, setSynonyms] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);

  const inputRef = useRef<TextInput>(null);
  const scrollRef = useRef<ScrollView>(null);
  const requestId = useRef(0);              // stale-response guard
  const lastOpenAt = useRef(0);             // double-open guard

  // --- open/close choreography ------------------------------------------------
  const scrimOpacity = useSharedValue(0);
  const panelScale = useSharedValue(visible ? 1 : 0.96);
  const panelY = useSharedValue(visible ? 0 : -12);

  useEffect(() => {
    if (visible) {
      // Fresh session every open.
      setQuery('');
      setResults(null);
      setSynonyms([]);
      setError(null);
      setLoading(false);
      setSelected(0);
      requestId.current += 1;               // invalidate any in-flight request
      scrimOpacity.value = withTiming(1, { duration: motion.modalInMs });
      panelScale.value = withTiming(1, { duration: motion.modalInMs, easing: Easing.out(Easing.cubic) });
      panelY.value = withTiming(0, { duration: motion.modalInMs, easing: Easing.out(Easing.cubic) });
      // Focus after the panel has mounted so the webview doesn't scroll-jump.
      const t = setTimeout(() => inputRef.current?.focus(), 40);
      return () => clearTimeout(t);
    }
    scrimOpacity.value = withTiming(0, { duration: motion.modalInMs });
    panelScale.value = withTiming(0.96, { duration: motion.modalInMs });
    panelY.value = withTiming(-12, { duration: motion.modalInMs });
  }, [visible, scrimOpacity, panelScale, panelY]);

  const scrimStyle = useAnimatedStyle(() => ({ opacity: scrimOpacity.value }));
  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ scale: panelScale.value }, { translateY: panelY.value }],
  }));

  // --- debounced live search (120 ms) ------------------------------------------
  useEffect(() => {
    if (!visible) return;
    const q = query.trim();
    if (!q) {
      requestId.current += 1;
      setResults(null);
      setSynonyms([]);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    const t = setTimeout(async () => {
      const id = ++requestId.current;
      try {
        const res = await api.search(q, { engine, transmission, source, limit: RESULT_LIMIT });
        if (id !== requestId.current) return; // stale — a newer keystroke won
        setResults(res.results);
        setSynonyms(res.synonyms_matched);
        setError(null);
      } catch (err) {
        if (id !== requestId.current) return;
        setResults([]);
        setSynonyms([]);
        setError(err instanceof ApiError ? err.message : 'Search failed.');
      } finally {
        if (id === requestId.current) {
          setLoading(false);
          setSelected(0); // new result set → selection back on top
        }
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, visible, engine, transmission, source]);

  // Keep the highlight index in range as results shrink.
  useEffect(() => {
    if (results && selected > results.length - 1) {
      setSelected(Math.max(0, results.length - 1));
    }
  }, [results, selected]);

  // --- actions ------------------------------------------------------------------
  const openResult = useCallback(
    (item: SearchResultItem): void => {
      const now = Date.now();
      if (now - lastOpenAt.current < OPEN_GUARD_MS) return; // Enter double-fire guard
      lastOpenAt.current = now;
      onOpenProcedure({ id: item.procedure_id, title: item.title });
      onClose();
    },
    [onClose, onOpenProcedure],
  );

  const moveSelection = useCallback(
    (delta: number): void => {
      setSelected((prev) => {
        const n = results?.length ?? 0;
        if (n === 0) return prev;
        return (prev + delta + n) % n; // wraps cleanly in both directions
      });
    },
    [results],
  );

  // Keep the highlighted row visible while navigating.
  useEffect(() => {
    // `scrollToIndex` is implemented by react-native-web but not always on
    // the RN instance type — access it defensively.
    const scroller = scrollRef.current as unknown as {
      scrollToIndex?: (opts: { index: number; viewPosition?: number }) => void;
    } | null;
    if (visible && results && results.length > 0) {
      scroller?.scrollToIndex?.({ index: selected, viewPosition: 0.5 });
    }
  }, [selected, visible, results]);

  // --- global keyboard navigation -------------------------------------------------
  // Window-level listener (not per-row): focus stays in the text input, and the
  // same path works in WebView2 (Windows) and WebKitGTK (Linux). Escape is also
  // handled by useGlobalShortcuts in the shell; closing twice is idempotent.
  useEffect(() => {
    if (!visible) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      switch (event.key) {
        case 'ArrowDown':
        case 'Tab':
          if (!event.shiftKey) {
            event.preventDefault(); // keep focus inside the Spotlight list
            moveSelection(1);
          } else {
            event.preventDefault();
            moveSelection(-1); // Shift+Tab
          }
          break;
        case 'ArrowUp':
          event.preventDefault();
          moveSelection(-1);
          break;
        case 'Enter': {
          event.preventDefault();
          const current = results?.[selected];
          if (current) openResult(current);
          break;
        }
        case 'Escape':
          onClose();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [visible, results, selected, moveSelection, openResult, onClose]);

  if (!visible) return null;

  const hasQuery = query.trim().length > 0;
  const showResults = results !== null && results.length > 0;

  return (
    <AnimView style={[styles.scrim, scrimStyle]} pointerEvents="box-none">
      {/* Backdrop click closes the modal. */}
      <Pressable accessibilityLabel="Close search" style={styles.backdrop} onPress={onClose} />

      <AnimView style={[styles.panel, panelStyle]}>
        {/* Input row ---------------------------------------------------------- */}
        <View style={styles.inputRow}>
          <Text style={styles.searchIcon}>⌕</Text>
          <TextInput
            ref={inputRef}
            value={query}
            onChangeText={setQuery}
            placeholder="Search procedures, torque specs, tips…"
            placeholderTextColor={colors.textSecondary}
            style={styles.input}
            autoCapitalize="none"
            returnKeyType="search"
          />
          <Kbd label="Esc" />
        </View>

        {/* Matched synonym chips ---------------------------------------------- */}
        {showResults && synonyms.length > 0 ? (
          <View style={styles.synonymRow}>
            <Text style={styles.synonymLabel}>Matched alias:</Text>
            {synonyms.map((s) => (
              <View key={s} style={styles.synonymChip}>
                <Text style={styles.synonymChipText}>{s}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {/* Results ------------------------------------------------------------- */}
        <ScrollView ref={scrollRef} bounces={false} style={styles.resultsScroll} contentContainerStyle={styles.resultsContent}>
          {!hasQuery ? (
            <View style={styles.stateBox}>
              <Text style={styles.stateTitle}>Spotlight search</Text>
              <Text style={styles.stateBody}>
                Type to search every WIS+ procedure — titles, steps, torque specs and tips.
              </Text>
              <View style={styles.hintRow}>
                <Kbd label="↑ ↓" />
                <Text style={styles.hintText}>navigate</Text>
                <Kbd label="↵" />
                <Text style={styles.hintText}>open</Text>
                <Kbd label="esc" />
                <Text style={styles.hintText}>close</Text>
              </View>
            </View>
          ) : loading ? (
            <View style={styles.stateBox}>
              <Text style={styles.stateBody}>Searching…</Text>
            </View>
          ) : error ? (
            <View style={styles.stateBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : !showResults ? (
            <View style={styles.stateBox}>
              <Text style={styles.stateTitle}>No matches</Text>
              <Text style={styles.stateBody}>
                Nothing found for “{query.trim()}”. Try an alias — e.g. {'“strut”'} or {'“damper”'}.
              </Text>
            </View>
          ) : (
            results.map((item, i) => (
              <ResultRow key={item.procedure_id} item={item} selected={i === selected} onOpen={() => openResult(item)} />
            ))
          )}
        </ScrollView>

        {/* Footer hint bar ------------------------------------------------------ */}
        <View style={styles.footer}>
          <Text style={styles.footerHint}>
            {showResults ? `${results.length} result${results.length === 1 ? '' : 's'} · ` : ''}↑ ↓ to navigate · ↵ opens in Focused Mode
          </Text>
          <Kbd label="Ctrl + Enter" />
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
    zIndex: 200,
  },
  backdrop: { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0 },
  panel: {
    width: '90%' as const,
    maxWidth: 680,
    maxHeight: '82%' as const,
    backgroundColor: colors.bgSurface,
    borderColor: colors.accentAmber, // the Spotlight focus border
    borderWidth: 1.5,
    borderRadius: radius.lg,
    overflow: 'hidden' as const,
    shadowColor: colors.shadow,
    shadowOpacity: 1,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 14 },
    elevation: 24,
  },

  inputRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
  searchIcon: { fontSize: 22, color: colors.textSecondary, marginRight: spacing.md },
  input: { flex: 1, fontSize: 17, color: colors.textPrimary, padding: 0 },

  kbd: {
    height: 24,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.hairlineStrong,
    backgroundColor: colors.bgElevated,
    paddingHorizontal: spacing.sm + 2,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    marginLeft: spacing.sm,
  },
  kbdText: { fontSize: 11, fontWeight: '700' as const, color: colors.textSecondary },

  synonymRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    flexWrap: 'wrap' as const,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  synonymLabel: { ...typography.caption, color: colors.textSecondary, marginRight: spacing.sm },
  synonymChip: {
    height: 22,
    borderRadius: radius.pill,
    backgroundColor: colors.amberDim,
    paddingHorizontal: spacing.md - 2,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    marginRight: spacing.sm,
    marginBottom: spacing.xs,
  },
  synonymChipText: { fontSize: 12, fontWeight: '600' as const, color: colors.accentAmber },

  resultsScroll: { maxHeight: 380 },
  resultsContent: { paddingVertical: spacing.sm },

  resultRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    marginHorizontal: spacing.md,
    marginBottom: spacing.xs,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.hairline,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md - 2,
    backgroundColor: 'transparent',
  },
  resultRowSelected: { backgroundColor: colors.bgElevated, borderColor: colors.hairlineStrong },
  rowIndicator: {
    width: 3,
    height: 30,
    borderRadius: radius.pill,
    backgroundColor: 'transparent',
    marginRight: spacing.md,
  },
  resultTitle: { ...typography.rowLabel, color: colors.textPrimary },
  resultBreadcrumb: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  resultSnippet: {
    ...typography.caption,
    color: colors.textSecondary,
    opacity: 0.8,
    marginTop: 2,
    fontStyle: 'italic' as const,
  },
  resultMeta: { alignItems: 'flex-end' as const, marginLeft: spacing.md },
  torquePill: {
    height: 22,
    borderRadius: radius.pill,
    backgroundColor: colors.amberDim,
    paddingHorizontal: spacing.md - 2,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    marginBottom: spacing.xs,
  },
  torquePillText: { fontSize: 11, fontWeight: '700' as const, color: colors.accentAmber },

  sourceBadge: {
    height: 20,
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: spacing.sm + 2,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  sourceBadgeText: { fontSize: 10, fontWeight: '800' as const, letterSpacing: 0.8 },

  stateBox: { alignItems: 'center' as const, paddingVertical: spacing.xl, paddingHorizontal: spacing.xl },
  stateTitle: { ...typography.rowLabel, color: colors.textPrimary, marginBottom: spacing.sm },
  stateBody: { ...typography.body, color: colors.textSecondary, textAlign: 'center' as const },
  hintRow: { flexDirection: 'row' as const, alignItems: 'center' as const, marginTop: spacing.lg },
  hintText: { ...typography.caption, color: colors.textSecondary, marginHorizontal: spacing.sm },
  errorText: { color: colors.dangerRed, ...typography.body, textAlign: 'center' as const },

  footer: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.hairline,
  },
  footerHint: { ...typography.caption, color: colors.textSecondary, flexShrink: 1 as const },
};
