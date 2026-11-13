import { useEffect, useState } from 'react';
import './formFamily.css';

/** Keep a draft open until the user explicitly discards it; saving always freezes dismissal. */
export function useFormDismiss({ open, dirty, busy, onClose }: {
  open: boolean;
  dirty: boolean;
  busy: boolean;
  onClose: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { if (!open || !dirty) setConfirming(false); }, [open, dirty]);

  function requestClose() {
    if (busy) return;
    if (dirty) setConfirming(true);
    else onClose();
  }

  const discardPrompt = confirming ? (
    <section className="form-discard" role="alert" aria-label="Thay đổi chưa lưu">
      <strong>Bỏ thay đổi chưa lưu?</strong>
      <p>Nội dung bạn vừa nhập sẽ không được lưu.</p>
      <div className="btn-row">
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setConfirming(false)}>Tiếp tục sửa</button>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => { if (busy) return; setConfirming(false); onClose(); }}>Bỏ thay đổi</button>
      </div>
    </section>
  ) : null;

  return { requestClose, discardPrompt };
}

/** Mutation failures stay beside the draft, not only in a short-lived toast. */
export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="form-error" role="alert">{error instanceof Error ? error.message : typeof error === 'string' ? error : 'Không lưu được. Nội dung vẫn được giữ, hãy thử lại.'}</p>;
}
