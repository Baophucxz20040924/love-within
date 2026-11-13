import type { QueryClient } from '@tanstack/react-query';
import { apiRequest } from '../../lib/apiClient';
import type { CoupleEvent, EventInput, EventList } from '../../lib/types';
import { PULSE_KEY } from '../couple/api';

// Event ids come from server data, but encode them anyway before building API paths.
const enc = encodeURIComponent;

export const eventsApi = {
  list: () => apiRequest<EventList>('/events'),
  create: (input: EventInput) => apiRequest<CoupleEvent>('/events', { method: 'POST', body: input }),
  update: (id: string, input: EventInput) => apiRequest<CoupleEvent>(`/events/${enc(id)}`, { method: 'PATCH', body: input }),
  remove: (id: string) => apiRequest<{ ok: true }>(`/events/${enc(id)}`, { method: 'DELETE' }),
};

export const EVENTS_KEY = ['events'] as const;

/** After a change: reload the list and the Home card. */
export async function refreshEvents(qc: QueryClient): Promise<void> {
  await Promise.all([qc.invalidateQueries({ queryKey: EVENTS_KEY }), qc.invalidateQueries({ queryKey: PULSE_KEY })]);
}
