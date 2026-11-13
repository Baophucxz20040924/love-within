import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../components/Icon';
import { useModal } from '../../hooks/useModal';
import './SecretBoat.css';

interface Props {
  onClose: () => void;
  onBoard: () => void;
}

/** A local, deliberately opt-in interlude. No credentials, requests or timers. */
export function SecretBoat({ onClose, onBoard }: Props) {
  const titleId = useId();
  const boatRef = useRef<HTMLButtonElement>(null);
  const boarding = useRef(false);
  const [settled, setSettled] = useState(false);
  const [hovered, setHovered] = useState(false);
  const { dialogRef, overlayRef, requestClose } = useModal({ open: true, onClose, initialFocusRef: boatRef });

  return createPortal(
    <div ref={overlayRef} className="secret-boat" onClick={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
      <div
        ref={dialogRef}
        className="secret-boat__scene"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDownCapture={(event) => { if (event.key === 'Tab') setSettled(true); }}
      >
        <button className="secret-boat__close icon-btn" type="button" aria-label="Đóng" onClick={requestClose}>
          <Icon name="x" size={22} />
        </button>
        <div className="secret-boat__heading">
          <span className="secret-boat__eyebrow" aria-hidden="true">MỘT CHUYẾN ĐI NHỎ</span>
          <h2 id={titleId}>Chạm vào thuyền</h2>
        </div>
        <div className="secret-boat__water">
          <svg className="secret-boat__landscape" viewBox="0 0 640 240" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
            <circle cx="518" cy="45" r="19" fill="#f5dfb6" />
            <path d="M0 140Q90 114 185 139T360 134T640 140V240H0Z" fill="#dce9e9" />
            <path d="M0 167Q80 155 165 171T340 164T510 171T680 164V240H0Z" fill="#c5dcdf" />
            <g fill="none" stroke="#6b939b" strokeWidth="2" strokeLinecap="round" opacity=".45">
              <path d="M30 190h55m30 23h78m246-23h63m-14 27h91M263 226h48M569 183h30" />
            </g>
            <g fill="#91a6aa"><circle cx="95" cy="49" r="2"/><circle cx="365" cy="33" r="2"/><circle cx="575" cy="86" r="2"/></g>
            <path d="m207 66 4 5 4-5m37-19 4 5 4-5" fill="none" stroke="#91a6aa" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <div
            className={`secret-boat__motion${settled ? ' secret-boat__motion--settled' : ''}`}
            style={{ animationPlayState: hovered ? 'paused' : 'running' }}
          >
            <button
              ref={boatRef}
              className="secret-boat__button"
              type="button"
              aria-label="Lên thuyền"
              onPointerEnter={() => setHovered(true)}
              onPointerLeave={() => setHovered(false)}
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
        </div>
        <p className="secret-boat__hint">Một chạm để bắt đầu.</p>
      </div>
    </div>,
    document.body,
  );
}
