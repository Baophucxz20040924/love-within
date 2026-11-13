import { apiRequest } from '../../lib/apiClient';
import type { Couple, CouplePulse } from '../../lib/types';

export const coupleApi = {
  get: () => apiRequest<Couple>('/couple'),
  /** Combined Home data; polled every 30 s while the tab is visible. */
  pulse: () => apiRequest<CouplePulse>('/couple/pulse'),
};

export const COUPLE_KEY = ['couple'] as const;
export const PULSE_KEY = ['couple', 'pulse'] as const;
