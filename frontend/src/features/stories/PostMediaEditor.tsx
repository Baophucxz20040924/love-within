import { useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { PostVideo } from './PostVideo';
import type { LocalMedia } from './postMedia';

function Preview({ item }: { item: LocalMedia }) {
  const blob = item.kind === 'new' && item.status === 'ready' ? item.blob : null;
  const [preview, setPreview] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (!blob) { setPreview(null); return; }
    const url = URL.createObjectURL(blob);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  const src = item.kind === 'existing' ? item.url : preview;
  if (item.kind === 'new' && item.status !== 'ready') return <p className="composer__media-message" role={item.status === 'error' ? 'alert' : 'status'}>
    <span>{item.file.name}</span>
    {item.status === 'error' ? item.error : 'Đang xử lý tệp…'}
  </p>;
  if (!src) return null;
  return item.mediaType === 'video' ? <PostVideo src={src} label="Xem trước video" /> : <>
    <img src={src} alt="Ảnh đính kèm bài viết" onError={() => setFailed(true)} />
    {failed && <p className="composer__media-message" role="alert">Không xem trước được ảnh. Hãy bỏ ảnh này và chọn lại JPEG/PNG.</p>}
  </>;
}

export function PostMediaEditor({ media, busy, onRemove, onAdd }: {
  media: LocalMedia[]; busy: boolean; onRemove: (id: string) => void; onAdd: () => void;
}) {
  if (!media.length) return null;
  const valid = media.filter((item) => item.kind === 'existing' || item.status !== 'error').length;
  return <div className="composer__photos">
    {media.map((item) => <div key={item.id} className={`composer__photo${item.mediaType === 'video' ? ' composer__photo--video' : ''}${item.kind === 'new' && item.status !== 'ready' ? ' composer__photo--message' : ''}`}>
      <Preview item={item} />
      <button type="button" className="composer__photo-remove" aria-label={item.mediaType === 'video' ? 'Bỏ video này' : 'Bỏ ảnh này'} disabled={busy} onClick={() => onRemove(item.id)}>
        <span><Icon name="x" size={16} /></span>
      </button>
    </div>)}
    {valid < 10 && <button type="button" className="composer__add" aria-label="Thêm ảnh hoặc video" disabled={busy} onClick={onAdd}><Icon name="plus" size={26} /></button>}
  </div>;
}
