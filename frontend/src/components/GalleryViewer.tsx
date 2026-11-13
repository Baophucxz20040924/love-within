import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { useModal } from '../hooks/useModal';

interface Props {
  urls: string[];
  /** Index to open at; null = closed. */
  index: number | null;
  onClose: () => void;
}

/** Full-screen photo gallery: swipe (CSS scroll-snap), arrow keys, Escape to close. */
export function GalleryViewer({ urls, index, onClose }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(index ?? 0);
  const { dialogRef, requestClose, isTopmost } = useModal({ open: index !== null, onClose });

  useEffect(() => {
    if (index === null) return;
    setCurrent(index);
    // Jump (no animation) to the tapped photo once the track is laid out.
    const frame = requestAnimationFrame(() => {
      const el = trackRef.current;
      if (el) el.scrollLeft = index * el.clientWidth;
    });
    return () => cancelAnimationFrame(frame);
  }, [index]);

  if (index === null) return null;

  return createPortal(
    <div
      ref={dialogRef}
      className="gallery"
      role="dialog"
      aria-modal="true"
      aria-label="Xem ảnh"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (!isTopmost || !trackRef.current || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        const track = trackRef.current;
        track.scrollBy({
          left: (event.key === 'ArrowRight' ? 1 : -1) * track.clientWidth,
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        });
      }}
    >
      <div className="gallery__bar">
        <span className="gallery__count num">
          {current + 1} / {urls.length}
        </span>
        <button type="button" className="icon-btn gallery__close" aria-label="Đóng" onClick={requestClose}>
          <Icon name="x" size={26} />
        </button>
      </div>
      <div
        ref={trackRef}
        className="gallery__track"
        onScroll={(e) => {
          const el = e.currentTarget;
          setCurrent(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
        }}
      >
        {urls.map((u, i) => (
          <div key={u} className="gallery__slide">
            {/* Load the visible photo and its neighbours now; the rest only when swiped near. */}
            <img
              src={u}
              alt={`Ảnh ${i + 1}`}
              loading={i === index || Math.abs(i - current) <= 1 ? 'eager' : 'lazy'}
              decoding="async"
            />
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
