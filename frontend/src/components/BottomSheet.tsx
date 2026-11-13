import { useId } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useModal } from '../hooks/useModal';
import { Icon } from './Icon';

interface Props {
  open: boolean;
  title: string;
  onClose: () => void;
  children?: ReactNode;
  /** Optional explicit scrollable body; children remain supported. */
  body?: ReactNode;
  /** Stays visible below the scrollable body. */
  footer?: ReactNode;
  busy?: boolean;
  initialFocusRef?: RefObject<HTMLElement>;
}

/** Thumb-reachable sheet with shared modal stacking and a separately scrolling body. */
export function BottomSheet({ open, title, onClose, children, body, footer, busy = false, initialFocusRef }: Props) {
  const titleId = useId();
  const { dialogRef, overlayRef, requestClose } = useModal({ open, onClose, busy, initialFocusRef });

  if (!open) return null;

  return createPortal(
    <div ref={overlayRef} className="sheet-backdrop" onClick={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
      <div
        ref={dialogRef}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy || undefined}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet__handle" aria-hidden="true" />
        <div className="sheet__header">
          <h2 id={titleId} className="sheet__title">{title}</h2>
          <button type="button" className="icon-btn" onClick={requestClose} disabled={busy} aria-label="Đóng">
            <Icon name="x" />
          </button>
        </div>
        <div className="sheet__body">{body ?? children}</div>
        {footer != null && <div className="sheet__footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
