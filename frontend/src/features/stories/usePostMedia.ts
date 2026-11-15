import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_POST_MEDIA, MAX_POST_VIDEOS, preparePostMedia } from './postMedia';
import type { ExistingMedia, LocalMedia, PostMediaFile } from './postMedia';

let nextId = 0;
function fromFiles(files: readonly File[]): PostMediaFile[] {
  return files.map(file => ({
    id: `post-media-${++nextId}`,
    kind: 'new',
    // Only a provisional label while queued. Sniffing + native decoding decide the actual type.
    mediaType: file.type.startsWith('video/') || /\.(mp4|webm|mov)$/i.test(file.name) ? 'video' : 'image',
    file,
    status: 'processing',
    mimeType: file.type,
    width: 0,
    height: 0,
  }));
}

/** Initial props are a snapshot of the draft, not a source that overwrites in-progress edits. */
export function usePostMedia(existing: readonly ExistingMedia[] = [], initialFiles: readonly File[] = []) {
  const [media, setMedia] = useState<LocalMedia[]>(() => [...existing, ...fromFiles(initialFiles)]);
  const active = useRef<{ id: string; controller: AbortController } | null>(null);
  const next = media.find((item): item is PostMediaFile => item.kind === 'new' && item.status === 'processing');

  useEffect(() => {
    if (!next) return;
    const controller = new AbortController();
    const task = { id: next.id, controller };
    active.current = task;
    void preparePostMedia(next.file, controller.signal).then(prepared => {
      if (controller.signal.aborted) return;
      setMedia(current => {
        // Check the latest state, not the selection-time count: rapid adds/removals cannot overfill a post.
        if (controller.signal.aborted || !current.some(item => item.id === next.id && item.kind === 'new' && item.status === 'processing')) return current;
        const valid = current.filter(item => item.kind === 'existing' || item.status === 'ready');
        const error = valid.length >= MAX_POST_MEDIA
          ? 'Mỗi bài có tối đa 10 ảnh và video. Hãy bỏ bớt tệp rồi chọn lại.'
          : prepared.mediaType === 'video' && valid.filter(item => item.mediaType === 'video').length >= MAX_POST_VIDEOS
            ? 'Mỗi bài chỉ có 1 video. Hãy bỏ video trước đó rồi chọn lại.'
            : undefined;
        return current.map(item => item.id !== next.id || item.kind !== 'new' ? item : error
          ? { ...item, mediaType: prepared.mediaType, status: 'error', error }
          : { ...item, ...prepared, status: 'ready', error: undefined });
      });
    }, error => {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : 'Không xử lý được tệp. Hãy đổi định dạng hoặc chọn tệp khác.';
      setMedia(current => controller.signal.aborted ? current : current.map(item => item.id === next.id && item.kind === 'new'
        ? { ...item, status: 'error', error: message }
        : item));
    });
    return () => {
      controller.abort();
      if (active.current === task) active.current = null;
    };
    // One effect per queue head. Appending files must not restart a decode already in progress.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [next?.id]);

  const addFiles = useCallback((files: readonly File[] | FileList) => {
    // Snapshot FileList before a caller clears its input; allocate IDs outside the state updater.
    const added = fromFiles(Array.from(files));
    setMedia(current => [...current, ...added]);
  }, []);
  const remove = useCallback((id: string) => {
    if (active.current?.id === id) active.current.controller.abort();
    setMedia(current => current.filter(item => item.id !== id));
  }, []);

  return {
    media,
    addFiles,
    remove,
    pending: media.some(item => item.kind === 'new' && item.status === 'processing'),
    errors: media.some(item => item.kind === 'new' && item.status === 'error'),
  };
}
