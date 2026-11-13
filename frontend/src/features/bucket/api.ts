import type { QueryClient } from '@tanstack/react-query';
import { apiRequest } from '../../lib/apiClient';
import type { BucketCompleteInput, BucketCompleteResult, BucketIdeas, BucketInput, BucketItem, BucketList, BucketStatus } from '../../lib/types';

// Item ids come from server data, but encode them anyway before building API paths.
const enc = encodeURIComponent;

export const bucketApi = {
  list: (status: BucketStatus) => apiRequest<BucketList>(`/bucket?status=${status}`),
  ideas: () => apiRequest<BucketIdeas>('/bucket/ideas'),
  create: (input: BucketInput) => apiRequest<BucketItem>('/bucket', { method: 'POST', body: input }),
  update: (id: string, input: BucketInput) => apiRequest<BucketItem>(`/bucket/${enc(id)}`, { method: 'PATCH', body: input }),
  remove: (id: string) => apiRequest<{ ok: true }>(`/bucket/${enc(id)}`, { method: 'DELETE' }),
  restore: (id: string) => apiRequest<BucketItem>(`/bucket/${enc(id)}/restore`, { method: 'POST' }),
  complete: (id: string, input: BucketCompleteInput) =>
    apiRequest<BucketCompleteResult>(`/bucket/${enc(id)}/complete`, { method: 'POST', body: input }),
  reopen: (id: string) => apiRequest<BucketItem>(`/bucket/${enc(id)}/reopen`, { method: 'POST' }),
};

export const BUCKET_KEY = ['bucket'] as const;
export const bucketListKey = (status: BucketStatus) => ['bucket', 'list', status] as const;
export const BUCKET_IDEAS_KEY = ['bucket', 'ideas'] as const;

/** After a change: both lists (and their counts, also on the Quests card) and the ideas' "Đã thêm". */
export async function refreshBucket(qc: QueryClient): Promise<void> {
  await qc.invalidateQueries({ queryKey: BUCKET_KEY });
}
