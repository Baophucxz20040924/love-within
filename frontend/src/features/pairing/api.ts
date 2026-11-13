import { apiRequest } from '../../lib/apiClient';
import type { PairingInvite } from '../../lib/types';

// There is no unpair in the app: unpairing is handled by an admin tool (owner decision).
export const pairingApi = {
  listInvites: () => apiRequest<PairingInvite[]>('/pairing/invites'),
  invite: (toEmail: string) =>
    apiRequest<PairingInvite>('/pairing/invite', { method: 'POST', body: { toEmail } }),
  accept: (id: string) =>
    apiRequest<{ coupleId: string }>(`/pairing/invites/${id}/accept`, { method: 'POST' }),
  reject: (id: string) => apiRequest<{ ok: true }>(`/pairing/invites/${id}/reject`, { method: 'POST' }),
  cancel: (id: string) => apiRequest<{ ok: true }>(`/pairing/invites/${id}/cancel`, { method: 'POST' }),
};
