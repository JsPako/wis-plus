/**
 * PdfVerifyPane — right pane (48%) of the split-screen garage workspace.
 *
 * Renders the high-resolution original scan page from
 * `GET /api/pdf/{document_id}/page/{page_number}` (URL via `api.pdfPageUrl`)
 * with a full viewer toolkit:
 *
 *   • Zoom In (`+`) / Zoom Out (`−`) / Fit Width, Page Prev/Next,
 *   • Pan support — nested vertical + horizontal ScrollViews (mouse wheel
 *     scrolls natively under react-native-web) plus drag-to-pan via
 *     PanResponder while zoomed in,
 *   • Interactive verification: when the left pane fires a `focusRequest`
 *     (torque-pill click or a step's "Verify in PDF" icon), this pane jumps
 *     to that exact page, smoothly scrolls so the target normalized
 *     `[x0, y0, x1, y1]` bounding box is centered in the viewport and draws
 *     an animated pulsing amber highlight over the exact printed text,
 *   • A verify-green "Verified on scan" chip while a highlight is active,
 *   • High-contrast **Scan Boost** toggle (`◐`) — requests the backend's
 *     enhanced PNG (faded-digit / exploded-diagram boost, Task 10) without
 *     touching page, zoom, scroll position or the active bbox highlight.
 *
 * All colors come from `@/theme/tokens` — no raw hex in this file.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  PanResponder,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { api } from '@/api/client';
import type { NormalizedBBox } from '@/types/api';
import { colors, radius, spacing, typography } from '@/theme/tokens';

const AnimView = Animated.View;

/** A verification request fired by the left pane (ProcedureView). */
export interface PdfFocusRequest {
  page: number;
  /** Normalized [0..1] page coordinates to center + highlight; null = page jump only. */
  bbox: NormalizedBBox | null;
  /** Monotonic counter so re-clicking the same target re-triggers. */
  nonce: number;
}

interface HighlightState {
  page: number;
  bbox: NormalizedBBox;
}

export interface PdfVerifyPaneProps {
  documentId: number;
  initialPage: number;
  orientation: 'portrait' | 'landscape';
  /** Human-readable source tag, e.g. `WIS · scan_042.pdf`. */
  sourceLabel?: string;
  focusRequest: PdfFocusRequest | null;
}

const A4_PORTRAIT_ASPECT = 1 / 1.4142; // width / height fallback before load
const A4_LANDSCAPE_ASPECT = 1.4142;
const ZOOM_STEP = 1.25;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const SCAN_DPI = 200;

function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/** Animated pulsing amber rectangle drawn over the verified bounding box. */
function PulseHighlight({ left, top, width, height }: {
  left: number;
  top: number;
  width: number;
  height: number;
}) {
  const pulse = useSharedValue(1);

  useEffect(() => {
    pulse.value = withRepeat(
      withSequence(
        withTiming(0.3, { duration: 650, easing: Easing.inOut(Easing.quad) }),
        withTiming(1, { duration: 650, easing: Easing.inOut(Easing.quad) }),
      ),
      -1,
      false,
    );
  }, [pulse]);

  const animated = useAnimatedStyle(() => ({
    opacity: pulse.value,
    transform: [{ scale: 1 + (1 - pulse.value) * 0.05 }],
  }));

  return (
    <AnimView pointerEvents="none" style={[styles.highlight, { left, top, width, height }, animated]} />
  );
}

function ToolButton({
  label,
  onPress,
  ariaLabel,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={ariaLabel}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.toolBtn,
        disabled && styles.toolBtnDisabled,
        pressed && !disabled && { opacity: 0.85 },
      ]}
    >
      <Text style={styles.toolBtnText}>{label}</Text>
    </Pressable>
  );
}

export default function PdfVerifyPane({
  documentId,
  initialPage,
  orientation,
  sourceLabel,
  focusRequest,
}: PdfVerifyPaneProps) {
  const [page, setPage] = useState(initialPage);
  const [zoom, setZoom] = useState(1); // 1.0 === fit width
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [highlight, setHighlight] = useState<HighlightState | null>(null);
  /** Task 10 — high-contrast Scan Boost (faded 80s microfiche scans). */
  const [scanBoost, setScanBoost] = useState(false);

  const vScroll = useRef<ScrollView>(null);
  const hScroll = useRef<ScrollView>(null);
  const offsetV = useRef(0);
  const offsetH = useRef(0);
  const pendingFocus = useRef<PdfFocusRequest | null>(null);
  const lastPt = useRef<{ x: number; y: number } | null>(null);

  // Displayed pixel size of the scan at the current zoom level.
  const aspect = natural
    ? natural.w / natural.h
    : orientation === 'landscape'
      ? A4_LANDSCAPE_ASPECT
      : A4_PORTRAIT_ASPECT;
  const dispW = viewport.w > 0 ? Math.round(viewport.w * zoom) : 0;
  const dispH = dispW > 0 ? Math.round(dispW / aspect) : 0;

  /** Smoothly scroll both axes so `bbox`'s center lands in the viewport center. */
  const centerOn = (bbox: NormalizedBBox | null) => {
    if (!bbox || viewport.w <= 0) return;
    const w = viewport.w * zoom;
    const h = w / aspect;
    const cx = ((bbox.x0 + bbox.x1) / 2) * w;
    const cy = ((bbox.y0 + bbox.y1) / 2) * h;
    hScroll.current?.scrollTo(Math.max(0, cx - viewport.w / 2), 0, true);
    vScroll.current?.scrollTo(0, Math.max(0, cy - viewport.h / 2), true);
  };

  // A new focus request arrives from the left pane: queue it + switch pages.
  useEffect(() => {
    if (!focusRequest) return;
    pendingFocus.current = focusRequest;
    setPage(focusRequest.page);
  }, [focusRequest]);

  // Page/document change: reset per-page state (natural size is page-specific).
  useEffect(() => {
    setNatural(null);
    setLoading(true);
    setError(null);
    offsetV.current = 0;
    offsetH.current = 0;
  }, [page, documentId]);

  // Scan Boost toggle: only the image source changes — page, zoom, scroll
  // offsets and the active bbox highlight are all preserved. Show the
  // spinner until the enhanced/original PNG arrives.
  useEffect(() => {
    setLoading(true);
  }, [scanBoost]);

  // Once the requested page's container is mounted (and again when the true
  // aspect ratio arrives after image load), center + light up the highlight.
  useEffect(() => {
    const req = pendingFocus.current;
    if (req && req.page === page) {
      pendingFocus.current = null;
      setHighlight(req.bbox ? { page, bbox: req.bbox } : null);
      centerOn(req.bbox);
    } else if (highlight?.page === page && natural) {
      // Aspect corrected after the scan loaded — re-center on the real geometry.
      centerOn(highlight.bbox);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, natural, viewport]);

  const navigate = (p: number) => {
    if (p < 1 || p === page) return;
    pendingFocus.current = null;
    setHighlight(null);
    setPage(p);
  };

  const onImgLoad = (e: {
    nativeEvent: { source?: { width?: number; height?: number } };
  }) => {
    const src = e.nativeEvent.source;
    if (src && src.width && src.height) setNatural({ w: src.width, h: src.height });
    setLoading(false);
  };

  const onImgError = () => {
    setLoading(false);
    setError(`Could not load page ${page} — it may be missing from this scan.`);
  };

  // Drag-to-pan while zoomed (mouse drag under react-native-web).
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: () => zoom > 1,
        onPanResponderGrant: (e) => {
          lastPt.current = { x: e.nativeEvent.locationX, y: e.nativeEvent.locationY };
        },
        onPanResponderMove: (e) => {
          const prev = lastPt.current;
          if (!prev) return;
          const dx = e.nativeEvent.locationX - prev.x;
          const dy = e.nativeEvent.locationY - prev.y;
          lastPt.current = { x: e.nativeEvent.locationX, y: e.nativeEvent.locationY };
          hScroll.current?.scrollTo(offsetH.current - dx, 0);
          vScroll.current?.scrollTo(0, offsetV.current - dy);
        },
        onPanResponderRelease: () => {
          lastPt.current = null;
        },
      }),
    [zoom],
  );

  const onLayout = (e: { nativeEvent: { layout: { width: number; height: number } } }) => {
    setViewport({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });
  };

  return (
    <View style={styles.root} onLayout={onLayout}>
      {/* Toolbar ---------------------------------------------------------- */}
      <View style={styles.toolbar}>
        <View style={styles.toolbarInfo}>
          <Text style={styles.toolbarLabel}>PDF Source</Text>
          {sourceLabel ? (
            <Text numberOfLines={1} style={styles.toolbarSub}>
              {sourceLabel}
            </Text>
          ) : null}
        </View>
        <ToolButton label="‹" ariaLabel="Previous page" disabled={page <= 1} onPress={() => navigate(page - 1)} />
        <View style={styles.pageIndicator}>
          <Text style={styles.pageIndicatorText}>p. {page}</Text>
        </View>
        <ToolButton label="›" ariaLabel="Next page" onPress={() => navigate(page + 1)} />
        <View style={styles.toolDivider} />
        <ToolButton
          label="−"
          ariaLabel="Zoom out"
          disabled={zoom <= ZOOM_MIN + 0.001}
          onPress={() => setZoom((z) => clampZoom(z / ZOOM_STEP))}
        />
        <ToolButton label="Fit W" ariaLabel="Fit width" onPress={() => setZoom(1)} />
        <ToolButton
          label="+"
          ariaLabel="Zoom in"
          disabled={zoom >= ZOOM_MAX - 0.001}
          onPress={() => setZoom((z) => clampZoom(z * ZOOM_STEP))}
        />
        <View style={styles.toolDivider} />
        {/* Task 10 — high-contrast Scan Boost toggle */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={scanBoost ? 'Disable scan boost' : 'Enable scan boost'}
          onPress={() => setScanBoost((b) => !b)}
          style={({ pressed }) => [
            styles.boostBtn,
            scanBoost ? styles.boostBtnOn : styles.boostBtnOff,
            pressed && { opacity: 0.85 },
          ]}
        >
          <Text style={[styles.boostIcon, { color: scanBoost ? colors.textOnAmber : colors.textSecondary }]}>
            ◐
          </Text>
          <Text
            style={[
              styles.boostLabel,
              { color: scanBoost ? colors.textOnAmber : colors.textPrimary },
            ]}
          >
            Scan Boost
          </Text>
        </Pressable>
      </View>

      {/* Check-by-eye chip (task 2.4: never say "verified") ------------------ */}
      {highlight && highlight.page === page ? (
        <View style={styles.verifyChip}>
          <View style={styles.verifyDot} />
          <Text style={styles.verifyText}>Check by eye · p. {highlight.page}</Text>
        </View>
      ) : null}

      {/* Viewer ------------------------------------------------------------ */}
      <View style={styles.viewer}>
        {error ? (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{error}</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setError(null);
                setLoading(true);
                setReloadKey((k) => k + 1);
              }}
              style={({ pressed }) => [styles.retryBtn, pressed && { opacity: 0.85 }]}
            >
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        ) : dispW > 0 ? (
          <>
            <ScrollView
              ref={vScroll}
              style={styles.scrollOuter}
              contentContainerStyle={styles.scrollOuterContent}
              scrollEventThrottle={16}
              showsVerticalScrollIndicator={false}
              onScroll={(e) => {
                offsetV.current = e.nativeEvent.contentOffset.y;
              }}
            >
              <ScrollView
                ref={hScroll}
                horizontal
                nestedScrollEnabled
                style={{ height: dispH }}
                contentContainerStyle={{ width: dispW, height: dispH }}
                scrollEventThrottle={16}
                showsHorizontalScrollIndicator={false}
                onScroll={(e) => {
                  offsetH.current = e.nativeEvent.contentOffset.x;
                }}
              >
                <View {...panResponder.panHandlers} style={{ width: dispW, height: dispH }}>
                  <Image
                    key={`${documentId}:${page}:${scanBoost ? 'boost' : 'raw'}:${reloadKey}`}
                    source={{ uri: api.pdfPageUrl(documentId, page, SCAN_DPI, scanBoost) }}
                    style={{ width: dispW, height: dispH }}
                    resizeMode="stretch"
                    onLoad={onImgLoad}
                    onError={onImgError}
                  />
                  {highlight && highlight.page === page ? (
                    <PulseHighlight
                      left={highlight.bbox.x0 * dispW}
                      top={highlight.bbox.y0 * dispH}
                      width={Math.max(8, (highlight.bbox.x1 - highlight.bbox.x0) * dispW)}
                      height={Math.max(8, (highlight.bbox.y1 - highlight.bbox.y0) * dispH)}
                    />
                  ) : null}
                </View>
              </ScrollView>
            </ScrollView>
            {loading ? (
              <View style={styles.spinnerWrap}>
                <ActivityIndicator size="large" color={colors.accentAmber} />
              </View>
            ) : null}
          </>
        ) : (
          <View style={styles.spinnerWrap}>
            <ActivityIndicator color={colors.accentAmber} />
          </View>
        )}
      </View>
    </View>
  );
}

const styles = {
  root: { flex: 1 as const, backgroundColor: colors.bgPrimary },

  // Toolbar ------------------------------------------------------------------
  toolbar: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.bgSurface,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
  toolbarInfo: { flex: 1 as const, marginRight: spacing.sm },
  toolbarLabel: { ...typography.sectionLabel, color: colors.textSecondary },
  toolbarSub: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  toolBtn: {
    minWidth: 34,
    height: 34,
    borderRadius: radius.md,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.hairlineStrong,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    paddingHorizontal: spacing.sm,
  },
  toolBtnDisabled: { opacity: 0.35 },
  toolBtnText: { fontSize: 14, fontWeight: '700' as const, color: colors.textPrimary },
  // Scan Boost toggle (Task 10) — tactile pill, accent-highlighted when active.
  boostBtn: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 6,
    height: 34,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: spacing.sm + 2,
  },
  boostBtnOff: { backgroundColor: colors.bgElevated, borderColor: colors.hairlineStrong },
  boostBtnOn: { backgroundColor: colors.accentPrimary, borderColor: colors.accentPrimary },
  boostIcon: { fontSize: 15, fontWeight: '700' as const },
  boostLabel: { fontSize: 12, fontWeight: '700' as const, letterSpacing: 0.3 },
  pageIndicator: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  pageIndicatorText: { fontSize: 12, fontWeight: '700' as const, color: colors.textPrimary },
  toolDivider: {
    width: 1,
    height: 22,
    backgroundColor: colors.hairlineStrong,
    marginHorizontal: spacing.xs,
  },

  // Verified chip -------------------------------------------------------------
  verifyChip: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    alignSelf: 'flex-start' as const,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.pill,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.verifyGreen,
  },
  verifyDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.verifyGreen, marginRight: spacing.sm },
  verifyText: { fontSize: 12, fontWeight: '700' as const, color: colors.verifyGreen },

  // Viewer ---------------------------------------------------------------------
  viewer: { flex: 1 as const, overflow: 'hidden' as const, backgroundColor: colors.bgPrimary },
  scrollOuter: { flex: 1 as const },
  scrollOuterContent: { minHeight: '100%' as const, justifyContent: 'center' as const },
  spinnerWrap: {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    backgroundColor: colors.scrim,
  },

  // Bounding-box highlight -----------------------------------------------------
  highlight: {
    position: 'absolute' as const,
    borderWidth: 3,
    borderColor: colors.accentAmber,
    backgroundColor: colors.amberDim,
  },

  // Error state -----------------------------------------------------------------
  errorCard: { flex: 1 as const, alignItems: 'center' as const, justifyContent: 'center' as const, padding: spacing.xl },
  errorText: { ...typography.body, color: colors.dangerRed, textAlign: 'center' as const },
  retryBtn: {
    marginTop: spacing.lg,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.pill,
    backgroundColor: colors.accentAmber,
  },
  retryText: { ...typography.rowLabel, color: colors.textOnAmber },
};
