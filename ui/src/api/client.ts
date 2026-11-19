/**
 * WIS+ typed fetch client for the local Python sidecar (`backend/main.py`).
 *
 * The backend binds 127.0.0.1 only; override with VITE_WISPLUS_API if needed.
 */

import type {
  CustomThemeJson,
  DirectoryCategory,
  HealthResponse,
  ProcedureDetail,
  SaveProfilePayload,
  SearchResponse,
  VehicleProfile,
} from '@/types/api';

const API_BASE: string = (
  (import.meta.env?.VITE_WISPLUS_API as string | undefined) ?? 'http://127.0.0.1:8321'
).replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, init);
  } catch (err) {
    throw new ApiError(0, `Backend unreachable at ${API_BASE} (${String(err)})`);
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { detail?: string };
      if (body.detail) detail = body.detail;
    } catch {
      /* non-JSON error body — keep statusText */
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

function withParams(base: string, params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${base}?${s}` : base;
}

export const api = {
  /** GET /api/health — used by the splash screen to know when to fade out. */
  health: () => request<HealthResponse>('/api/health'),

  /** GET /api/profile — current build preferences (defaults: everything 'ALL'). */
  getProfile: () => request<VehicleProfile>('/api/profile'),

  /** POST /api/profile — persist the user's engine/transmission choice. */
  saveProfile: (payload: SaveProfilePayload) =>
    request<VehicleProfile>('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  // ---------------------------------------------------------------------------
  // Theme engine (Task 7.5) — custom themes + active theme persistence
  // ---------------------------------------------------------------------------
  /** GET /api/themes — list every valid custom theme in ./themes/*.json. */
  getThemes: () => request<CustomThemeJson[]>('/api/themes'),

  /** POST /api/themes — validate + persist a new theme as themes/{id}.json. */
  importTheme: (theme: CustomThemeJson) =>
    request<CustomThemeJson>('/api/themes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(theme),
    }),

  /** POST /api/profile — persist just the active theme id (merge, safe). */
  setActiveTheme: (activeThemeId: string) =>
    request<VehicleProfile>('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active_theme_id: activeThemeId }),
    }),

  /** GET /api/directory — collapsible index, filtered by the active profile. */
  directory: (engine?: string, transmission?: string) =>
    request<DirectoryCategory[]>(withParams('/api/directory', { engine, transmission })),

  /** GET /api/search — instant hybrid (FTS5 + vector) search. */
  search: (
    q: string,
    opts?: { engine?: string; transmission?: string; source?: 'WIS' | 'HAYNES'; limit?: number },
  ) =>
    request<SearchResponse>(
      withParams('/api/search', { q, engine: opts?.engine, transmission: opts?.transmission, source: opts?.source, limit: opts?.limit }),
    ),

  /** GET /api/procedures/{id} — full procedure incl. torque specs + bbox. */
  procedure: (procedureId: number) => request<ProcedureDetail>(`/api/procedures/${procedureId}`),

  /** URL of the original-scan page PNG (LRU-cached server-side). Not a fetch — hand to <Image>.
   *  `enhance=true` requests the backend's high-contrast Scan Boost pipeline (Task 10). */
  pdfPageUrl: (documentId: number, pageNumber: number, dpi = 180, enhance = false) =>
    `${API_BASE}/api/pdf/${documentId}/page/${pageNumber}?dpi=${dpi}${enhance ? '&enhance=true' : ''}`,
};
