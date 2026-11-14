import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import './SecretBoat.css';

interface Props {
  onClose: () => void;
  onBoard: () => void;
}

/** An opt-in detail on the page, never a modal or an automatic navigation. */
export function SecretBoat({ onClose, onBoard }: Props) {
  const boarding = useRef(false);
  const [settled, setSettled] = useState(false);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, [onClose]);

  return (
    <div className="secret-boat">
      <div
        className={`secret-boat__motion${settled ? ' secret-boat__motion--settled' : ''}`}
        style={{ animationPlayState: paused ? 'paused' : 'running' }}
      >
        <button
          className="secret-boat__button"
          type="button"
          aria-label="Lên thuyền"
          title="Lên thuyền"
          onPointerEnter={() => setPaused(true)}
          onPointerLeave={() => setPaused(false)}
          onPointerDown={() => setPaused(true)}
          onPointerUp={() => setPaused(false)}
          onPointerCancel={() => setPaused(false)}
          onFocus={(event) => { if (event.currentTarget.matches(':focus-visible')) setSettled(true); }}
          onClick={() => {
            if (boarding.current) return;
            boarding.current = true;
            onBoard();
          }}
        >
          <svg viewBox="0 0 160 168" fill="none" aria-hidden="true">
            <ellipse cx="82" cy="152" rx="65" ry="6" fill="#6b939b" opacity=".18" />
            <path d="M81 21v110" stroke="#345367" strokeWidth="4" strokeLinecap="round" />
            <path d="M75 32 28 109h47V32Z" fill="#fff9eb" stroke="#dfd6c4" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="m88 42 43 67H88V42Z" fill="#efd4c3" stroke="#dbb49d" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="m80 19 23 7-23 8V19Z" fill="#b56566" />
            <path d="M16 124h129l-22 22H42l-26-22Z" fill="#345367" />
            <path d="M16 124h129" stroke="#b98463" strokeWidth="5" strokeLinecap="round" />
            <path d="M38 136h84" stroke="#718d9c" strokeWidth="2" strokeLinecap="round" />
            <path d="M57 120v-7h18v7" fill="#b98463" />
            <circle cx="104" cy="134" r="3" fill="#f8e7c6" />
            <path d="M11 153h27m83 2h26" stroke="#6b939b" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <button className="secret-boat__close" type="button" aria-label="Ẩn thuyền" onClick={onClose}>
        <Icon name="x" size={16} />
      </button>
    </div>
  );
}
