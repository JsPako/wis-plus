/**
 * WIS+ API contract — TypeScript mirrors of `backend/main.py` +
 * `shared/models.py`. These types are the JSON shapes over 127.0.0.1.
 */

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
export interface HealthResponse {
  status: 'ok';
  db_loaded: boolean;
  procedure_count: number;
  schema_version?: number;  // v3: reported by backend when DB is loaded
}

// ---------------------------------------------------------------------------
// Vehicle profile (user-selectable build — the app never assumes a car)
// ---------------------------------------------------------------------------
export type Facelift = 'pre-facelift' | 'facelift';

export interface VehicleProfile {
  /** Filter token, e.g. 'ALL', 'M102_1.8', 'M103_2.6'. */
  engine: string;
  /** Filter token, e.g. 'ALL', 'AUTO_722.4', 'MANUAL_717.4'. */
  transmission: string;
  year: number | null;            // 1983..1993
  facelift: Facelift | null;
  configured: boolean;            // false until the user explicitly picks a build
  /** Active theme id (Task 7.5) — defaults to 'workshop-dark'. */
  active_theme_id: string;
}

/** POST /api/profile — body. Backend merges: only fields present are changed, so the Settings screen can update the car profile and the Theme Engine can persist `active_theme_id` without clobbering each other. */
export type SaveProfilePayload = Pick<VehicleProfile, 'engine' | 'transmission'> &
  Partial<Pick<VehicleProfile, 'year' | 'facelift' | 'active_theme_id'>>;

// ---------------------------------------------------------------------------
// Theme engine (Task 7.5) — wire shape of themes/*.json and /api/themes.
// Mirrors backend/theme_loader.py:ThemeFile exactly.
// ---------------------------------------------------------------------------
export interface CustomThemeColors {
  bgPrimary: string;
  bgSurface: string;
  bgElevated: string;
  borderSubtle: string;
  accentPrimary: string;
  accentSecondary: string;
  verifyGreen: string;
  dangerRed: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
}

export interface CustomThemeJson {
  id: string;              // slug, e.g. 'silver-arrow'
  name: string;
  description: string;
  author: string;
  isDark: boolean;
  colors: CustomThemeColors;
}

/** A selectable option in the profile modal: display label + filter token. */
export interface ProfileOption {
  label: string;
  value: string;
}

/** Engine variants offered by the W201 range (labels exactly as printed). */
export const ENGINE_OPTIONS: readonly ProfileOption[] = [
  { label: 'All Engines', value: 'ALL' },
  { label: 'M102 1.8 (102.910)', value: 'M102_1.8' },
  { label: 'M102 2.0 (102.962)', value: 'M102_2.0' },
  { label: 'M102 2.3 (102.985)', value: 'M102_2.3' },
  { label: 'M102 2.3-16 / 2.5-16', value: 'M102_16V' },
  { label: 'M103 2.6', value: 'M103_2.6' },
  { label: 'OM601 / OM602 Diesel', value: 'OM601_602' },
];

export const TRANSMISSION_OPTIONS: readonly ProfileOption[] = [
  { label: 'All Transmissions', value: 'ALL' },
  { label: 'Automatic (722.4)', value: 'AUTO_722.4' },
  { label: 'Manual 4-Speed (716.2)', value: 'MANUAL_716.2' },
  { label: 'Manual 5-Speed (717.4)', value: 'MANUAL_717.4' },
];

export function optionLabel(
  options: readonly ProfileOption[],
  value: string | null | undefined,
): string {
  if (!value) return 'Unknown';
  return options.find((o) => o.value === value)?.label ?? value;
}

// ---------------------------------------------------------------------------
// Directory tree (collapsible index)
// ---------------------------------------------------------------------------
export interface DirectoryProcedureSummary {
  id: number;
  title: string;
}

export interface DirectorySubcategory {
  name: string;
  procedures: DirectoryProcedureSummary[];
}

export interface DirectoryCategory {
  category: string;
  subcategories: DirectorySubcategory[];
}

// ---------------------------------------------------------------------------
// Spotlight search
// ---------------------------------------------------------------------------
export type ManualSource = 'WIS' | 'HAYNES';

export interface SearchResultItem {
  procedure_id: number;
  title: string;
  category: string;
  subcategory: string;
  snippet: string | null;
  fts_rank: number;                    // lower is better (FTS5 bm25)
  vector_score: number | null;         // cosine similarity in [0, 1]
  combined_score: number;
  engine_variants: string[];
  transmission_variants: string[];
  page_id: number | null;
  torque_count: number;
}

export interface SearchResponse {
  query: string;
  results: SearchResultItem[];
  synonyms_matched: string[];          // "Also matching: ..." chips
}

// ---------------------------------------------------------------------------
// Procedure detail
// ---------------------------------------------------------------------------
export interface ToolItem {
  name: string;
  size_or_code: string | null;         // '17 mm' or a Mercedes special-tool code
  is_mercedes_special: boolean;
}

/** Bounding box in normalized [0, 1] page coordinates (origin top-left). */
export interface NormalizedBBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ProcedureStep {
  step_num: number;
  text: string;
  tip: string | null;
  bbox: NormalizedBBox | null;         // location of the step on the source page
}

export type StepMode = 'removal' | 'installation' | 'general';

export interface TorqueSpec {
  id: number | null;
  procedure_id: number;
  page_id: number;
  step_mode: StepMode;
  component_name: string;
  value_nm: number | null;            // v3: nullable (CHECK enforces range when present)
  value_ftlb: number | null;
  raw_text: string;
  bbox: NormalizedBBox;                // exact spot on the scan to verify by eye
  bbox_exact: boolean;                 // v3: false = approximate/estimated box
  angle_deg: number | null;            // v3: rotation in degrees (rotated scans)
}

export interface SourcePageRef {
  document_id: number;
  page_number: number;
  orientation: 'portrait' | 'landscape';
  source_type: ManualSource;
  filename: string;
}

export interface ProcedureDetail {
  id: number;
  title: string;
  category: string;
  subcategory: string;
  engine_variants: string[];
  transmission_variants: string[];
  review_flags: string[];              // v3: warning strings (unknown_variant:X, variant_unspecified, …)
  stages: Record<string, unknown>[];   // v3: multi-stage procedure objects
  tools_required: ToolItem[];
  removal_steps: ProcedureStep[];
  installation_steps: ProcedureStep[];
  general_tips: string[];
  torque_specs: TorqueSpec[];
  page: SourcePageRef;
}
