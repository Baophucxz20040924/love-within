import { apiRequest } from '../../lib/apiClient';
import type { Proposal } from '../../lib/types';

export const proposalsApi = {
  listPending: () => apiRequest<Proposal[]>('/proposals?status=pending'),
  approve: (id: string) => apiRequest<Proposal>(`/proposals/${id}/approve`, { method: 'POST' }),
  reject: (id: string) => apiRequest<Proposal>(`/proposals/${id}/reject`, { method: 'POST' }),
  proposeAnniversary: (date: string) =>
    apiRequest<Proposal>('/couple/anniversary/propose', { method: 'POST', body: { date } }),
};

export const PROPOSAL_KEY = ['proposals', 'pending'] as const;
