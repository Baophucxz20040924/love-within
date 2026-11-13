import type { CSSProperties } from 'react';
import type { StoryPhotoView } from '../../lib/types';

interface Props {
  photos: StoryPhotoView[];
  onOpen: (index: number) => void;
}

/** Single photo keeps its shape, clamped between 4:5 portrait and 1.91:1 landscape (like Facebook). */
function singleRatio(p: StoryPhotoView): string {
  const r = Math.min(1.91, Math.max(0.8, p.width / p.height));
  return `${r}`;
}

/**
 * Facebook-style photo layouts:
 * 1 → full width · 2 → side by side · 3 → one large + two small · 4 → 2×2 · 5+ → 2 on top, 3 below, "+N" on the last.
 */
export function PhotoGrid({ photos, onOpen }: Props) {
  const n = photos.length;
  if (n === 0) return null;

  const shown = n > 5 ? photos.slice(0, 5) : photos;
  const extra = n - shown.length;
  const firstPortrait = photos[0].height > photos[0].width;

  let gridStyle: CSSProperties;
  const cellStyle = (i: number): CSSProperties => {
    if (n === 1) return { aspectRatio: singleRatio(photos[0]) };
    if (n === 2) return { aspectRatio: '1' };
    if (n === 3) {
      if (i === 0) return firstPortrait ? { gridRow: 'span 2' } : { gridColumn: 'span 2', aspectRatio: '2' };
      return { aspectRatio: '1' };
    }
    if (n === 4) return { aspectRatio: '1' };
    // 5+: 6-column grid → top cells span 3, bottom cells span 2.
    return i < 2 ? { gridColumn: 'span 3', aspectRatio: '1' } : { gridColumn: 'span 2', aspectRatio: '1' };
  };

  if (n === 1) gridStyle = { gridTemplateColumns: '1fr' };
  else if (n >= 5) gridStyle = { gridTemplateColumns: 'repeat(6, 1fr)' };
  else gridStyle = { gridTemplateColumns: '1fr 1fr' };

  return (
    <div className="pgrid" style={gridStyle}>
      {shown.map((p, i) => (
        <button
          key={p.key}
          type="button"
          className="pgrid__cell"
          style={cellStyle(i)}
          onClick={() => onOpen(i)}
          aria-label={`Xem ảnh ${i + 1} trên ${n}`}
        >
          <img src={p.url} alt="" loading="lazy" decoding="async" />
          {extra > 0 && i === shown.length - 1 && <span className="pgrid__more">+{extra}</span>}
        </button>
      ))}
    </div>
  );
}
