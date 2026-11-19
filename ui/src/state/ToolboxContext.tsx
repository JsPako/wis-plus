/**
 * ToolboxContext — the multi-job "Toolbox Grab List" (Task 9).
 *
 * When a job spans several WIS+ procedures (front struts + ball joints +
 * anti-roll bar…), the mechanic pins each procedure's Required Tools card
 * into one shared grab list. This provider:
 *
 *   • persists pinned jobs + checkbox state in `localStorage`, so the
 *     drawer survives a reload mid-job,
 *   • merges every pinned job's tool list into ONE deduplicated checklist,
 *     splitting **Mercedes-Benz special tools** from **metric spanners /
 *     sockets / drivers** (sorted naturally by mm size),
 *   • records which pinned jobs require each merged tool, so the mechanic
 *     sees exactly why a 17mm spanner is on the list.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import type { ToolItem } from '@/types/api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A procedure pinned into the grab list. */
export interface PinnedJob {
  procedureId: number;
  title: string;
  tools: ToolItem[];
}

/** One deduplicated tool row in the merged checklist. */
export interface MergedTool {
  /** Normalized identity key — also the checkbox-state key. */
  key: string;
  name: string;
  sizeOrCode: string | null;
  isSpecial: boolean;
  /** Titles of every pinned job that requires this tool. */
  requiredBy: string[];
}

/** The merged, deduplicated, sorted grab list. */
export interface MergedTools {
  standard: MergedTool[]; // spanners / sockets / drivers — by mm size
  special: MergedTool[]; // Mercedes-Benz special tools — by part code
  total: number;
}

interface ToolboxContextValue {
  /** Pinned jobs, in the order they were pinned. */
  pinnedJobs: PinnedJob[];
  isPinned: (procedureId: number) => boolean;
  /** Pin a procedure's tools, or unpin it if already pinned. */
  togglePinJob: (procedure: { id: number; title: string; tools: ToolItem[] }) => void;
  /** Drop every pinned job (and reset the checkbox state). */
  clearAllJobs: () => void;
  /** Normalized tool keys currently ticked off. */
  checkedTools: ReadonlySet<string>;
  toggleToolChecked: (key: string) => void;
  /** Un-tick every checkbox without touching the pinned jobs. */
  resetChecked: () => void;
  mergedTools: MergedTools;
}

// ---------------------------------------------------------------------------
// Normalization & sorting helpers
// ---------------------------------------------------------------------------

/** Stable identity for a tool: name + size/code, case- and whitespace-insensitive. */
export function normalizeToolKey(tool: ToolItem): string {
  const name = tool.name.trim().toLowerCase().replace(/\s+/g, ' ');
  const size = (tool.size_or_code ?? '').trim().toLowerCase().replace(/\s+/g, '');
  return `${name}|${size}`;
}

/** First numeric value in the size/code/name — used for natural mm sorting. */
function sizeSortValue(tool: ToolItem): number | null {
  const haystack = tool.size_or_code ?? tool.name;
  const m = haystack.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

function compareStandard(a: MergedTool, b: MergedTool): number {
  // Spanners/sockets/drivers first by mm size; non-numeric items last, A→Z.
  const sizeA = a.sizeOrCode ? (sizeSortValue({ name: a.name, size_or_code: a.sizeOrCode, is_mercedes_special: false }) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
  const sizeB = b.sizeOrCode ? (sizeSortValue({ name: b.name, size_or_code: b.sizeOrCode, is_mercedes_special: false }) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
  if (sizeA !== sizeB) return sizeA - sizeB;
  return a.name.localeCompare(b.name);
}

function compareSpecial(a: MergedTool, b: MergedTool): number {
  const codeA = a.sizeOrCode ?? a.name;
  const codeB = b.sizeOrCode ?? b.name;
  return codeA.localeCompare(codeB, undefined, { numeric: true }) || a.name.localeCompare(b.name);
}

// ---------------------------------------------------------------------------
// Persistence (localStorage)
// ---------------------------------------------------------------------------

const JOBS_KEY = 'wisplus.toolbox.jobs.v1';
const CHECKED_KEY = 'wisplus.toolbox.checked.v1';

function loadPinnedJobs(): PinnedJob[] {
  try {
    const raw = window.localStorage.getItem(JOBS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as unknown[]).filter(
      (j): j is PinnedJob => {
        const o = j as PinnedJob;
        return (
          typeof o?.procedureId === 'number' &&
          typeof o?.title === 'string' &&
          Array.isArray(o?.tools) &&
          o.tools.every(
            (t) => t != null && typeof t.name === 'string' && typeof t.is_mercedes_special === 'boolean',
          )
        );
      },
    );
  } catch {
    return [];
  }
}

function loadChecked(): Set<string> {
  try {
    const raw = window.localStorage.getItem(CHECKED_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set((parsed as unknown[]).filter((k): k is string => typeof k === 'string'));
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const ToolboxContext = createContext<ToolboxContextValue | undefined>(undefined);

export function ToolboxProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [pinnedJobs, setPinnedJobs] = useState<PinnedJob[]>(loadPinnedJobs);
  const [checkedTools, setCheckedTools] = useState<Set<string>>(loadChecked);

  // Persist on every change — the grab list must survive a reload mid-job.
  useEffect(() => {
    try { window.localStorage.setItem(JOBS_KEY, JSON.stringify(pinnedJobs)); } catch { /* in-memory only */ }
  }, [pinnedJobs]);

  useEffect(() => {
    try { window.localStorage.setItem(CHECKED_KEY, JSON.stringify([...checkedTools])); } catch { /* in-memory only */ }
  }, [checkedTools]);

  const isPinned = useCallback(
    (procedureId: number) => pinnedJobs.some((j) => j.procedureId === procedureId),
    [pinnedJobs],
  );

  const togglePinJob = useCallback((procedure: { id: number; title: string; tools: ToolItem[] }) => {
    setPinnedJobs((prev) =>
      prev.some((j) => j.procedureId === procedure.id)
        ? prev.filter((j) => j.procedureId !== procedure.id)
        : [...prev, { procedureId: procedure.id, title: procedure.title, tools: procedure.tools }],
    );
  }, []);

  const clearAllJobs = useCallback(() => {
    setPinnedJobs([]);
    setCheckedTools(new Set()); // fresh checklist for the next job
  }, []);

  const toggleToolChecked = useCallback((key: string) => {
    setCheckedTools((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const resetChecked = useCallback(() => setCheckedTools(new Set()), []);

  // Merged, deduplicated & sorted grab list -----------------------------------
  const mergedTools: MergedTools = useMemo(() => {
    const byKey = new Map<string, MergedTool>();
    for (const job of pinnedJobs) {
      for (const tool of job.tools) {
        const key = normalizeToolKey(tool);
        const existing = byKey.get(key);
        if (existing) {
          if (!existing.requiredBy.includes(job.title)) {
            existing.requiredBy.push(job.title);
          }
        } else {
          byKey.set(key, {
            key,
            name: tool.name,
            sizeOrCode: tool.size_or_code,
            isSpecial: tool.is_mercedes_special,
            requiredBy: [job.title],
          });
        }
      }
    }

    const standard: MergedTool[] = [];
    const special: MergedTool[] = [];
    byKey.forEach((t) => (t.isSpecial ? special : standard).push(t));
    standard.sort(compareStandard);
    special.sort(compareSpecial);

    return { standard, special, total: standard.length + special.length };
  }, [pinnedJobs]);

  const value = useMemo<ToolboxContextValue>(
    () => ({
      pinnedJobs,
      isPinned,
      togglePinJob,
      clearAllJobs,
      checkedTools,
      toggleToolChecked,
      resetChecked,
      mergedTools,
    }),
    [pinnedJobs, isPinned, togglePinJob, clearAllJobs, checkedTools, toggleToolChecked, resetChecked, mergedTools],
  );

  return <ToolboxContext.Provider value={value}>{children}</ToolboxContext.Provider>;
}

export function useToolbox(): ToolboxContextValue {
  const ctx = useContext(ToolboxContext);
  if (!ctx) throw new Error('useToolbox() must be used inside <ToolboxProvider>');
  return ctx;
}
