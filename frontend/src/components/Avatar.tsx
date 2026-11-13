import { useState } from 'react';

const PALETTE: [string, string][] = [
  ['#ffe4e8', '#be123c'],
  ['#e0f2fe', '#0369a1'],
  ['#fef3c7', '#b45309'],
  ['#dcfce7', '#15803d'],
  ['#ede9fe', '#6d28d9'],
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Vietnamese given name comes last: "Nguyễn Thu Hà" → "H". */
function initial(name: string): string {
  const words = name.trim().split(/\s+/);
  const word = words[words.length - 1] ?? '';
  return (Array.from(word)[0] ?? '?').toLocaleUpperCase('vi');
}

interface Props {
  name: string;
  size?: number;
  ring?: boolean;
  /** Profile photo URL; falls back to the initial when missing or when it fails to load. */
  src?: string | null;
}

/** Profile photo, or an initial with a stable color per name. Decorative: the name is always shown next to it. */
export function Avatar({ name, size = 40, ring = false, src }: Props) {
  const [failed, setFailed] = useState<string | null>(null);
  const [bg, fg] = PALETTE[hash(name) % PALETTE.length];
  const photo = src && failed !== src ? src : null;
  return (
    <span
      className={`avatar${ring ? ' avatar--ring' : ''}${photo ? ' avatar--photo' : ''}`}
      style={{ width: size, height: size, background: photo ? undefined : bg, color: fg, fontSize: Math.round(size * 0.42) }}
      aria-hidden="true"
    >
      {photo ? <img src={photo} alt="" loading="lazy" decoding="async" onError={() => setFailed(photo)} /> : initial(name)}
    </span>
  );
}
