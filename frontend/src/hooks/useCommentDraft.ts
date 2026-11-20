import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useAuth } from '../features/auth/AuthContext';
import { isAppLocked, subscribeAppLock } from '../features/appLock/store';
import { getVerifiedIdentity, subscribeVerification } from '../features/realtime/verification';
import { ApiRequestError } from '../lib/apiClient';
import { commentDraftStore, type CommentDraft, type CommentDraftScope } from '../lib/commentDraftStore';
import { tokenStore } from '../lib/tokenStore';

export function useCommentDraft(kind: 'story' | 'event', resourceId: string, aclReady: boolean) {
  const { me, space } = useAuth();
  const generation = tokenStore.generation();
  const userId = me?.user.id ?? '';
  const coupleId = space === 'couple' ? me?.couple?.id ?? '' : '';
  const identity = useSyncExternalStore(subscribeVerification, getVerifiedIdentity);
  const locked = useSyncExternalStore(subscribeAppLock, isAppLocked);
  const version = useSyncExternalStore(commentDraftStore.subscribe, commentDraftStore.version);
  const handle = useMemo(() => commentDraftStore.open({ generation, userId, space, coupleId, kind, resourceId }), [generation, userId, space, coupleId, kind, resourceId, version]);
  const ready = aclReady && !locked && !!userId && identity?.generation === generation && identity.userId === userId && identity.space === space;
  const draft = ready ? commentDraftStore.read(handle) : undefined;
  const current = () => {
    const verified = getVerifiedIdentity();
    return ready && !isAppLocked() && tokenStore.isCurrent(generation) && verified?.generation === generation && verified.userId === userId && verified.space === space;
  };
  return {
    ready,
    text: draft?.text ?? '',
    rootId: draft?.rootId ?? null,
    snapshot: () => commentDraftStore.read(handle),
    setText: (text: string, rootId: string | null = draft?.rootId ?? null) => {
      if (current()) commentDraftStore.write(handle, text, rootId);
    },
    clear: (expected?: CommentDraft) => commentDraftStore.clear(handle, expected),
    discard: () => commentDraftStore.clear(handle),
  };
}

/** Only authoritative REST denial deletes text; transient errors and verification masks do not. */
export function useCommentDraftDenial(kind: 'story' | 'event', resourceId: string, error: unknown) {
  const { me, space } = useAuth();
  const generation = tokenStore.generation(), userId = me?.user.id ?? '', coupleId = space === 'couple' ? me?.couple?.id ?? '' : '';
  useEffect(() => {
    if (!userId || !(error instanceof ApiRequestError) || (error.status !== 403 && error.status !== 404)) return;
    const scope: CommentDraftScope = { generation, userId, space, coupleId, kind, resourceId };
    commentDraftStore.revoke(scope);
  }, [generation, userId, space, coupleId, kind, resourceId, error]);
  return () => {
    if (userId && tokenStore.isCurrent(generation)) commentDraftStore.revoke({ generation, userId, space, coupleId, kind, resourceId });
  };
}
