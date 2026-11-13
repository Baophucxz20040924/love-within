import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BottomSheet } from '../../components/BottomSheet';
import { useToast } from '../../components/Toast';
import { ApiRequestError } from '../../lib/apiClient';
import { formatDate, formatSignedVnd, formatTime } from '../../lib/format';
import type { BankTxn } from '../../lib/types';
import { financeApi, financeOwnerKey } from './api';
import { BankSavingsAction } from '../savings/SavingsSheets';

const MAX_NOTE = 200;

/** Owner-only note on one of my transactions. The partner never gets this sheet. */
export function NoteSheet({ txn, onClose }: { txn: BankTxn | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [discard, setDiscard] = useState(false);
  const submitting = useRef(false);

  useEffect(() => {
    setNote(txn?.note ?? '');
    setError(null);
    setDiscard(false);
  }, [txn?.id]);

  const save = useMutation({
    mutationFn: (value: string) => financeApi.setNote(txn!.id, value),
    onSuccess: async (t) => {
      toast.success(t.note ? 'Đã lưu ghi chú' : 'Đã xóa ghi chú');
      onClose();
      await qc.invalidateQueries({ queryKey: financeOwnerKey('mine') });
    },
    onError: (err) => setError(err instanceof ApiRequestError ? err.message : 'Có lỗi xảy ra, thử lại nhé.'),
    onSettled: () => { submitting.current = false; },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    submit(note.trim());
  }

  function submit(value: string) {
    if (!txn || submitting.current) return;
    submitting.current = true;
    setError(null);
    save.mutate(value);
  }

  function requestClose() {
    if (submitting.current) return;
    if (note !== (txn?.note ?? '')) setDiscard(true);
    else onClose();
  }

  const unchanged = note.trim() === (txn?.note ?? '');

  return (
    <>
    <BottomSheet open={txn !== null} onClose={requestClose} busy={save.isPending} title="Ghi chú giao dịch">
      {txn && (
        <form className="form" onSubmit={onSubmit}>
          <div>
            <p className={`note-sheet__amount ${txn.direction === 'in' ? 'money-in' : 'money-out'}`}>
              {formatSignedVnd(txn.direction, txn.amount)}
            </p>
            <p className="text-sm text-muted">
              {txn.direction === 'in' ? 'Tiền vào' : 'Tiền ra'} · {formatTime(txn.occurredAt)}, {formatDate(txn.occurredAt)}
            </p>
          </div>
          <label className="field">
            <span className="field__label">Ghi chú</span>
            <textarea
              className="input"
              value={note}
              disabled={save.isPending}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'finance-note-error' : undefined}
              onChange={(e) => setNote(e.target.value)}
              maxLength={MAX_NOTE}
              placeholder="VD: Ăn tối với người ấy, tiền nhà tháng 11…"
            />
            <span className="char-count">
              {note.length}/{MAX_NOTE}
            </span>
          </label>
          {error && <p id="finance-note-error" className="form-error" role="alert">{error}</p>}
          <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={unchanged || save.isPending}>
            Lưu ghi chú
          </button>
          {txn.note && (
            <button type="button" className="btn btn-ghost btn-block" disabled={save.isPending} onClick={() => submit('')}>
              Xóa ghi chú
            </button>
          )}
          <BankSavingsAction key={txn.id} txn={txn} disabled={save.isPending} />
        </form>
      )}
    </BottomSheet>
    <BottomSheet open={discard} onClose={() => setDiscard(false)} title="Bỏ thay đổi ghi chú?">
      <p className="text-muted">Ghi chú chưa lưu sẽ bị bỏ.</p>
      <div className="btn-row">
        <button type="button" className="btn btn-secondary" onClick={() => setDiscard(false)}>Tiếp tục sửa</button>
        <button type="button" className="btn btn-danger" onClick={() => { setDiscard(false); onClose(); }}>Bỏ thay đổi</button>
      </div>
    </BottomSheet>
    </>
  );
}
