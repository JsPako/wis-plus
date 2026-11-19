/**
 * ProcedureView — the garage split-screen workspace (Task 7).
 *
 *   ┌──────────────────────────────┬─────────────────────────────┐
 *   │ Left 52% — extracted text    │ Right 48% — PdfVerifyPane   │
 *   │   mode tabs · tools card     │   original scan + bbox      │
 *   │   steps + torque pills       │   pulsing highlight         │
 *   └──────────────────────────────┴─────────────────────────────┘
 *
 * Left-pane features (per the WIS+ UX spec):
 *   • Mode switcher: **Installation** / **Removal** / **All Torque & Specs**,
 *   • Required Tools & Spanners card — chip per tool, Mercedes special tools
 *     highlighted in signal amber with their part code,
 *   • Clickable inline torque pills (signal-amber) inside steps and in the
 *     torque summary — clicking one fires a focus request to the PDF pane,
 *   • Garage tips: inline off-notes inside each step, toggleable via the
 *     `💡 Garage Tips` toolbar button which cycles Inline → Off → All
 *     (aggregated card with every tip from both phases + general tips),
 *   • Step completion checkboxes with a running progress count.
 *
 * The "← Back to Directory" header control lives in the App shell; this
 * component owns everything below it once a procedure is focused.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';

import PdfVerifyPane, { type PdfFocusRequest } from '@/components/PdfVerifyPane';
import { api } from '@/api/client';
import type {
  ProcedureDetail,
  ProcedureStep,
  StepMode,
  ToolItem,
  TorqueSpec,
} from '@/types/api';
import { colors, radius, spacing, typography } from '@/theme/tokens';

/** Left/right split ratio per the UX spec. */
const LEFT_BASIS = '52%' as const;
const RIGHT_BASIS = '48%' as const;

type ModeTab = 'installation' | 'removal' | 'torque';
type TipsMode = 'inline' | 'off' | 'all';

const TIPS_MODES: TipsMode[] = ['inline', 'off', 'all'];
const TIPS_LABEL: Record<TipsMode, string> = {
  inline: '💡 Garage Tips · Inline',
  off: '💡 Garage Tips · Off',
  all: '💡 Garage Tips · All',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'onto', 'into', 'each', 'all']);

function significantTokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/** Heuristic: does this step's text talk about that torque spec's component? */
function stepMentionsComponent(stepText: string, componentName: string): boolean {
  const tokens = significantTokens(componentName);
  if (tokens.length === 0) return false;
  const hay = stepText.toLowerCase();
  const hits = tokens.filter((t) => hay.includes(t)).length;
  return hits / tokens.length >= 0.6;
}

function specLabel(spec: TorqueSpec): string {
  return spec.value_ftlb != null ? `${spec.value_nm} Nm · ${spec.value_ftlb} ft·lb` : `${spec.value_nm} Nm`;
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------
function ToolChip({ tool }: { tool: ToolItem }) {
  const special = tool.is_mercedes_special;
  return (
    <View style={[styles.toolChip, special && styles.toolChipSpecial]}>
      {special ? <Text style={styles.toolStar}>★</Text> : null}
      <Text numberOfLines={2} style={[styles.toolName, special && { color: colors.textOnAmber }]}>
        {tool.name}{tool.size_or_code ? ` · ${tool.size_or_code}` : ''}
      </Text>
    </View>
  );
}

function TorquePill({ spec, onVerify }: { spec: TorqueSpec; onVerify: (spec: TorqueSpec) => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Verify ${spec.component_name} torque of ${specLabel(spec)} in the PDF`}
      onPress={() => onVerify(spec)}
      style={({ pressed }) => [styles.torquePill, pressed && { opacity: 0.85 }]}
    >
      <Text style={styles.torquePillText}>{specLabel(spec)}</Text>
    </Pressable>
  );
}

function VerifyInPdfButton({ onPress, label }: { onPress: () => void; label: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.verifyBtn, pressed && { opacity: 0.85 }]}
    >
      <Text style={styles.verifyBtnIcon}>⌖</Text>
      <Text style={styles.verifyBtnText}>Verify in PDF</Text>
    </Pressable>
  );
}

interface StepRowProps {
  step: ProcedureStep;
  checked: boolean;
  onToggle: () => void;
  tipsMode: TipsMode;
  inlineSpecs: TorqueSpec[];
  onVerifySpec: (spec: TorqueSpec) => void;
  onVerifyStep: (step: ProcedureStep) => void;
}

function StepRow({ step, checked, onToggle, tipsMode, inlineSpecs, onVerifySpec, onVerifyStep }: StepRowProps) {
  const hasBbox = step.bbox != null;
  return (
    <View style={[styles.stepCard, checked && styles.stepCardDone]}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityLabel={`Mark step ${step.step_num} ${checked ? 'incomplete' : 'complete'}`}
        onPress={onToggle}
        hitSlop={8}
        style={({ pressed }) => [styles.checkbox, checked && styles.checkboxDone, pressed && { opacity: 0.8 }]}
      >
        <Text style={[styles.checkboxTick, !checked && { color: 'transparent' }]}>✓</Text>
      </Pressable>
      <View style={styles.stepBody}>
        <View style={styles.stepHeaderRow}>
          <Text style={[styles.stepNum, checked && styles.stepNumDone]}>{step.step_num}</Text>
          <Text numberOfLines={checked ? 2 : undefined} style={[styles.stepText, checked && styles.stepTextDone]}>
            {step.text}
          </Text>
        </View>
        {inlineSpecs.length > 0 ? (
          <View style={styles.inlinePillsRow}>
            {inlineSpecs.map((spec) => (
              <TorquePill key={`${spec.id ?? 'x'}-${spec.component_name}`} spec={spec} onVerify={onVerifySpec} />
            ))}
          </View>
        ) : null}
        {tipsMode === 'inline' && step.tip ? (
          <View style={styles.tipNote}>
            <Text style={styles.tipIcon}>💡</Text>
            <Text style={styles.tipText}>{step.tip}</Text>
          </View>
        ) : null}
        {hasBbox ? (
          <VerifyInPdfButton label={`Verify step ${step.step_num} in the PDF`} onPress={() => onVerifyStep(step)} />
        ) : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function ProcedureView({ id }: { id: number }) {
  const [detail, setDetail] = useState<ProcedureDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<ModeTab>('installation');
  const [tipsMode, setTipsMode] = useState<TipsMode>('inline');
  const [checked, setChecked] = useState<Record<string, boolean>>({});

  const nonceRef = useRef(0);
  const [focusRequest, setFocusRequest] = useState<PdfFocusRequest | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    void api
      .procedure(id)
      .then((d) => !cancelled && setDetail(d))
      .catch(() => !cancelled && setError('Failed to load the procedure.'));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const fireVerify = (page: number, bbox: PdfFocusRequest['bbox']) => {
    nonceRef.current += 1;
    setFocusRequest({ page, bbox, nonce: nonceRef.current });
  };

  const verifySpec = (spec: TorqueSpec) => fireVerify(spec.page_id, spec.bbox);
  const verifyStep = (step: ProcedureStep) => {
    if (!detail || !step.bbox) return;
    fireVerify(detail.page.page_number, step.bbox);
  };

  // Derived data -------------------------------------------------------------
  const stepsForMode: ProcedureStep[] = useMemo(() => {
    if (!detail || mode === 'torque') return [];
    return mode === 'installation' ? detail.installation_steps : detail.removal_steps;
  }, [detail, mode]);

  const specsForMode: TorqueSpec[] = useMemo(() => {
    if (!detail) return [];
    const wanted: StepMode[] = mode === 'torque' ? ['removal', 'installation', 'general'] : [mode];
    return detail.torque_specs.filter((s) => wanted.includes(s.step_mode));
  }, [detail, mode]);

  /** Specs that clearly belong to a given step (token-overlap heuristic). */
  const inlineSpecsFor = (step: ProcedureStep): TorqueSpec[] =>
    specsForMode.filter((spec) => stepMentionsComponent(step.text, spec.component_name));

  const doneCount = stepsForMode.filter((s) => checked[`${mode}:${s.step_num}`]).length;

  const allTips = useMemo(() => {
    if (!detail) return [] as { from: string; tip: string }[];
    const out: { from: string; tip: string }[] = [];
    detail.general_tips.forEach((tip) => out.push({ from: 'General', tip }));
    detail.removal_steps.forEach((s) => s.tip && out.push({ from: `Removal ${s.step_num}`, tip: s.tip }));
    detail.installation_steps.forEach((s) => s.tip && out.push({ from: `Installation ${s.step_num}`, tip: s.tip }));
    return out;
  }, [detail]);

  const toggleStep = (stepNum: number) =>
    setChecked((prev) => ({ ...prev, [`${mode}:${stepNum}`]: !prev[`${mode}:${stepNum}`] }));

  // Render --------------------------------------------------------------------
  return (
    <View style={styles.root}>
      {/* Left pane — extracted procedure & specs --------------------------- */}
      <View style={[styles.leftPane, { flexBasis: LEFT_BASIS }]}>
        {!detail ? (
          <View style={styles.centerWrap}>
            {error ? (
              <Text style={styles.errorText}>{error}</Text>
            ) : (
              <ActivityIndicator size="large" color={colors.accentAmber} />
            )}
          </View>
        ) : (
          <>
            {/* Header + toolbar ------------------------------------------- */}
            <View style={styles.headerBlock}>
              <Text numberOfLines={2} style={styles.title}>{detail.title}</Text>
              <Text style={styles.crumb}>
                {detail.category} › {detail.subcategory} · {detail.page.source_type} p. {detail.page.page_number}
              </Text>
              <View style={styles.toolbarRow}>
                <View style={styles.tabGroup}>
                  {(
                    [
                      ['installation', 'Installation'],
                      ['removal', 'Removal'],
                      ['torque', 'All Torque & Specs'],
                    ] as [ModeTab, string][]
                  ).map(([tab, label]) => (
                    <Pressable
                      key={tab}
                      accessibilityRole="button"
                      onPress={() => setMode(tab)}
                      style={({ pressed }) => [
                        styles.tab,
                        mode === tab && styles.tabActive,
                        pressed && { opacity: 0.85 },
                      ]}
                    >
                      <Text style={[styles.tabText, mode === tab && styles.tabTextActive]}>{label}</Text>
                    </Pressable>
                  ))}
                </View>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setTipsMode((m) => TIPS_MODES[(TIPS_MODES.indexOf(m) + 1) % TIPS_MODES.length])}
                  style={({ pressed }) => [styles.tipsBtn, tipsMode !== 'inline' && styles.tipsBtnAlt, pressed && { opacity: 0.85 }]}
                >
                  <Text style={[styles.tipsBtnText, tipsMode !== 'inline' && { color: colors.textOnAmber }]}>
                    {TIPS_LABEL[tipsMode]}
                  </Text>
                </Pressable>
              </View>
            </View>

            <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
              {/* Tools & spanners ------------------------------------------ */}
              {mode !== 'torque' && detail.tools_required.length > 0 ? (
                <View style={styles.card}>
                  <Text style={styles.sectionLabel}>Required Tools & Spanners</Text>
                  <View style={styles.chipWrap}>
                    {detail.tools_required.map((tool) => (
                      <ToolChip key={`${tool.name}-${tool.size_or_code ?? ''}`} tool={tool} />
                    ))}
                  </View>
                  {detail.tools_required.some((t) => t.is_mercedes_special) ? (
                    <Text style={styles.specialNote}>★ = Mercedes-Benz special tool (order by part code)</Text>
                  ) : null}
                </View>
              ) : null}

              {/* Aggregated tips card --------------------------------------- */}
              {tipsMode === 'all' && allTips.length > 0 ? (
                <View style={styles.card}>
                  <Text style={styles.sectionLabel}>💡 Garage Tips — all ({allTips.length})</Text>
                  {allTips.map((t, i) => (
                    <View key={`${t.from}-${i}`} style={styles.tipRow}>
                      <Text style={styles.tipFrom}>{t.from}</Text>
                      <Text style={styles.tipText}>{t.tip}</Text>
                    </View>
                  ))}
                </View>
              ) : null}

              {/* Steps ------------------------------------------------------ */}
              {mode !== 'torque' ? (
                <>
                  <View style={styles.stepsHeader}>
                    <Text style={styles.sectionLabel}>
                      {mode === 'installation' ? 'Installation' : 'Removal'} — {stepsForMode.length} steps
                    </Text>
                    <Text style={styles.progressText}>
                      {doneCount}/{stepsForMode.length} done
                    </Text>
                  </View>
                  {stepsForMode.map((step) => (
                    <StepRow
                      key={`${mode}-${step.step_num}`}
                      step={step}
                      checked={!!checked[`${mode}:${step.step_num}`]}
                      onToggle={() => toggleStep(step.step_num)}
                      tipsMode={tipsMode}
                      inlineSpecs={inlineSpecsFor(step)}
                      onVerifySpec={verifySpec}
                      onVerifyStep={verifyStep}
                    />
                  ))}
                </>
              ) : null}

              {/* All Torque & Specs tab -------------------------------------- */}
              {mode === 'torque' ? (
                <View style={styles.card}>
                  <Text style={styles.sectionLabel}>All Torque & Specs ({specsForMode.length})</Text>
                  {specsForMode.length === 0 ? (
                    <Text style={styles.emptyText}>No torque values extracted for this procedure.</Text>
                  ) : (
                    specsForMode.map((spec) => (
                      <View key={`${spec.id ?? 'x'}-${spec.component_name}`} style={styles.specRow}>
                        <View style={styles.specInfo}>
                          <Text style={styles.specComponent}>{spec.component_name}</Text>
                          <Text style={styles.specMeta}>
                            {spec.step_mode === 'general' ? 'General' : spec.step_mode === 'installation' ? 'Installation' : 'Removal'} · scan p. {spec.page_id}
                          </Text>
                        </View>
                        <TorquePill spec={spec} onVerify={verifySpec} />
                      </View>
                    ))
                  )}
                  <Text style={styles.specHint}>Tap a value to jump the PDF to the exact printed line.</Text>
                </View>
              ) : null}
            </ScrollView>
          </>
        )}
      </View>

      {/* Divider + right pane — original PDF source ------------------------- */}
      <View style={styles.paneDivider} />
      {detail ? (
        <View style={[styles.rightPane, { flexBasis: RIGHT_BASIS }]}>
          <PdfVerifyPane
            key={detail.id}
            documentId={detail.page.document_id}
            initialPage={detail.page.page_number}
            orientation={detail.page.orientation}
            sourceLabel={`${detail.page.source_type} · ${detail.page.filename}`}
            focusRequest={focusRequest}
          />
        </View>
      ) : (
        <View style={[styles.rightPane, { flexBasis: RIGHT_BASIS }, styles.centerWrap]}>
          <Text style={styles.placeholderText}>PDF source viewer</Text>
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles — tokens only
// ---------------------------------------------------------------------------
const styles = {
  root: { flex: 1 as const, flexDirection: 'row' as const, backgroundColor: colors.bgPrimary },
  leftPane: { flexGrow: 1 as const, flexShrink: 1 as const, minWidth: 0 as const },
  rightPane: { flexGrow: 1 as const, flexShrink: 1 as const, minWidth: 0 as const },
  paneDivider: { width: 2, backgroundColor: colors.hairlineStrong },
  centerWrap: { flex: 1 as const, alignItems: 'center' as const, justifyContent: 'center' as const, padding: spacing.xl },

  // Header / toolbar -----------------------------------------------------------
  headerBlock: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
    backgroundColor: colors.bgSurface,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
  title: { fontSize: 22, fontWeight: '800' as const, color: colors.textPrimary, marginBottom: 4 },
  crumb: { ...typography.caption, color: colors.textSecondary, marginBottom: spacing.md },
  toolbarRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: spacing.md },
  tabGroup: {
    flexDirection: 'row' as const,
    backgroundColor: colors.bgPrimary,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.hairlineStrong,
    padding: 3,
  },
  tab: { paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radius.pill },
  tabActive: { backgroundColor: colors.accentAmber },
  tabText: { fontSize: 13, fontWeight: '700' as const, color: colors.textSecondary },
  tabTextActive: { color: colors.textOnAmber },
  tipsBtn: {
    marginLeft: 'auto' as const,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.hairlineStrong,
  },
  tipsBtnAlt: { backgroundColor: colors.accentAmber, borderColor: colors.accentAmber },
  tipsBtnText: { fontSize: 13, fontWeight: '700' as const, color: colors.textPrimary },

  // Scroll content -------------------------------------------------------------
  scrollContent: { padding: spacing.xl, paddingBottom: spacing.xxl },
  card: {
    backgroundColor: colors.bgSurface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.hairline,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  sectionLabel: { ...typography.sectionLabel, color: colors.textSecondary, marginBottom: spacing.md },

  // Tools ------------------------------------------------------------------------
  chipWrap: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: spacing.sm },
  toolChip: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.hairlineStrong,
    maxWidth: 280,
  },
  toolChipSpecial: { backgroundColor: colors.accentAmber, borderColor: colors.accentAmber },
  toolStar: { color: colors.textOnAmber, fontWeight: '700' as const, marginRight: spacing.xs + 2 },
  toolName: { fontSize: 13, fontWeight: '600' as const, color: colors.textPrimary },
  specialNote: { ...typography.caption, color: colors.accentAmber, marginTop: spacing.sm },

  // Steps ------------------------------------------------------------------------
  stepsHeader: {
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const,
    alignItems: 'baseline' as const,
    marginBottom: spacing.md,
  },
  progressText: { ...typography.caption, fontWeight: '700' as const, color: colors.verifyGreen },
  stepCard: {
    flexDirection: 'row' as const,
    backgroundColor: colors.bgSurface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.hairline,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  stepCardDone: { opacity: 0.62 },
  checkbox: {
    width: 26,
    height: 26,
    borderRadius: radius.sm,
    borderWidth: 2,
    borderColor: colors.hairlineStrong,
    backgroundColor: colors.bgPrimary,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    marginRight: spacing.md,
    marginTop: 2,
  },
  checkboxDone: { backgroundColor: colors.verifyGreen, borderColor: colors.verifyGreen },
  checkboxTick: { fontSize: 15, fontWeight: '800' as const, color: colors.textPrimary },
  stepBody: { flex: 1 as const },
  stepHeaderRow: { flexDirection: 'row' as const, alignItems: 'flex-start' as const },
  stepNum: {
    minWidth: 24,
    height: 24,
    borderRadius: radius.pill,
    backgroundColor: colors.bgElevated,
    borderWidth: 1,
    borderColor: colors.hairlineStrong,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    marginRight: spacing.sm + 2,
  },
  stepNumDone: { backgroundColor: colors.verifyGreen, borderColor: colors.verifyGreen },
  stepText: { ...typography.body, flexShrink: 1 as const, color: colors.textPrimary },
  stepTextDone: { textDecorationLine: 'line-through' as const, color: colors.textSecondary },

  // Torque pills + verify ---------------------------------------------------------
  inlinePillsRow: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: spacing.sm, marginTop: spacing.sm },
  torquePill: {
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.accentAmber,
    borderWidth: 1,
    borderColor: colors.accentAmber,
  },
  torquePillText: { fontSize: 13, fontWeight: '800' as const, color: colors.textOnAmber },
  verifyBtn: {
    alignSelf: 'flex-start' as const,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    marginTop: spacing.sm + 2,
    paddingHorizontal: spacing.sm + 4,
    paddingVertical: 5,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.hairlineStrong,
    backgroundColor: colors.bgPrimary,
  },
  verifyBtnIcon: { fontSize: 13, color: colors.accentAmber, marginRight: spacing.xs + 2 },
  verifyBtnText: { ...typography.caption, fontWeight: '700' as const, color: colors.textSecondary },

  // Tips ---------------------------------------------------------------------------
  tipNote: {
    flexDirection: 'row' as const,
    marginTop: spacing.sm,
    paddingLeft: spacing.md,
    borderLeftWidth: 3,
    borderLeftColor: colors.accentAmber,
    backgroundColor: colors.amberDim,
    borderRadius: radius.sm,
    paddingVertical: spacing.sm,
    paddingRight: spacing.md,
  },
  tipIcon: { fontSize: 14, marginRight: spacing.sm },
  tipText: { ...typography.caption, flexShrink: 1 as const, color: colors.textPrimary },
  tipRow: {
    flexDirection: 'row' as const,
    alignItems: 'flex-start' as const,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
  tipFrom: { ...typography.caption, fontWeight: '700' as const, color: colors.accentAmber, width: 130, flexShrink: 0 as const },

  // Torque summary tab ---------------------------------------------------------------
  specRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    gap: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
  specInfo: { flexShrink: 1 as const },
  specComponent: { ...typography.rowLabel, color: colors.textPrimary },
  specMeta: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  specHint: { ...typography.caption, color: colors.textSecondary, marginTop: spacing.md, fontStyle: 'italic' as const },

  // Misc ------------------------------------------------------------------------------
  emptyText: { ...typography.body, color: colors.textSecondary },
  errorText: { ...typography.body, color: colors.dangerRed, textAlign: 'center' as const },
  placeholderText: { ...typography.sectionLabel, color: colors.textSecondary },
};
