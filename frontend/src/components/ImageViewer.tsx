import { createPortal } from 'react-dom';
import { useModal } from '../hooks/useModal';
import { Icon } from './Icon';

interface Props {
  src: string | null | undefined;
  alt: string;
  onClose: () => void;
}

/** Full-screen photo preview (tap anywhere or Escape to close). */
export function ImageViewer({ src, alt, onClose }: Props) {
  const { dialogRef, requestClose } = useModal({ open: !!src, onClose });
  if (!src) return null;
  return createPortal(
    <div ref={dialogRef} className="viewer" role="dialog" aria-modal="true" aria-label={alt || 'Xem ảnh'} tabIndex={-1} onClick={requestClose}>
      <button type="button" className="icon-btn viewer__close" aria-label="Đóng ảnh" onClick={(event) => { event.stopPropagation(); requestClose(); }}>
        <Icon name="x" size={26} />
      </button>
      <img src={src} alt={alt} />
    </div>,
    document.body,
  );
}
