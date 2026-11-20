import { useEffect, useState } from 'react';

import { api } from '@/api/client';
import { ENGINE_OPTIONS, TRANSMISSION_OPTIONS, type ProfileOption } from '@/types/api';

export interface VariantOptions {
  engines: readonly ProfileOption[];
  gearboxes: readonly ProfileOption[];
}

/**
 * Engine/gearbox options for the profile picker.
 *
 * Starts from the built-in list so the UI renders on an offline start, then
 * replaces it with GET /api/variants when the backend is reachable — keeping
 * shared/variants.json the single source of truth (Task 2.1). If the fetch
 * fails (offline) the built-in fallback stays in place.
 */
export function useVariantOptions(): VariantOptions {
  const [options, setOptions] = useState<VariantOptions>({
    engines: ENGINE_OPTIONS,
    gearboxes: TRANSMISSION_OPTIONS,
  });

  useEffect(() => {
    let active = true;
    api
      .getVariants()
      .then((v) => {
        if (active && v.engines.length > 0 && v.gearboxes.length > 0) setOptions(v);
      })
      .catch(() => {
        /* offline: keep the built-in fallback */
      });
    return () => {
      active = false;
    };
  }, []);

  return options;
}