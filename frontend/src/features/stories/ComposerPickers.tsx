import { useEffect, useId, useRef, useState } from 'react';
import { BottomSheet } from '../../components/BottomSheet';
import type { Mood } from '../../lib/types';
import { MOODS } from './constants';

/** "Bạn đang cảm thấy thế nào?" */
export function MoodSheet({
  open,
  value,
  onClose,
  onPick,
}: {
  open: boolean;
  value: Mood | null;
  onClose: () => void;
  onPick: (m: Mood | null) => void;
}) {
  return (
    <BottomSheet open={open} onClose={onClose} title="Bạn đang cảm thấy thế nào?">
      <div className="mood-grid" role="group" aria-label="Chọn cảm xúc">
        {MOODS.map((m) => (
          <button
            key={m.key}
            type="button"
            aria-pressed={value === m.key}
            className={`mood-opt${value === m.key ? ' is-active' : ''}`}
            onClick={() => {
              onPick(m.key);
              onClose();
            }}
          >
            <span className="mood-opt__emoji" aria-hidden="true">
              {m.emoji}
            </span>
            <span>{m.label}</span>
          </button>
        ))}
      </div>
      {value && (
        <button
          type="button"
          className="btn btn-ghost btn-block"
          style={{ marginTop: 10 }}
          onClick={() => {
            onPick(null);
            onClose();
          }}
        >
          Bỏ cảm xúc
        </button>
      )}
    </BottomSheet>
  );
}

/** Day the memory happened (the post still sorts by posting time). */
export function DateSheet({
  open,
  value,
  max,
  resetDay,
  resetLabel,
  onClose,
  onPick,
}: {
  open: boolean;
  value: string;
  max: string;
  resetDay: string;
  resetLabel: string;
  onClose: () => void;
  onPick: (day: string) => void;
}) {
  const [date, setDate] = useState(value);
  const hintId = useId();
  const dateRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) setDate(value);
  }, [open, value]);

  return (
    <BottomSheet open={open} onClose={onClose} title="Ngày diễn ra kỷ niệm" initialFocusRef={dateRef}>
      <div className="form">
        <p className="text-muted">Kỷ niệm này diễn ra vào ngày nào? Bài viết vẫn hiện theo thời gian đăng.</p>
        <label className="field">
          <span className="field__label">Ngày</span>
          <input ref={dateRef} className="input" type="date" value={date} max={max} aria-invalid={!date || date > max} aria-describedby={hintId} onChange={(e) => setDate(e.target.value)} />
          <span id={hintId} className="field__hint">{!date ? 'Chọn một ngày để tiếp tục.' : date > max ? 'Ngày kỷ niệm không thể ở tương lai.' : 'Chọn hôm nay hoặc một ngày đã qua.'}</span>
        </label>
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              onPick(resetDay);
              onClose();
            }}
          >
            {resetLabel}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!date || date > max}
            onClick={() => {
              onPick(date);
              onClose();
            }}
          >
            Xong
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}

/** Facebook's "Lưu làm bản nháp?" when leaving the composer with content. */
export function LeaveSheet({
  open,
  editing,
  hasPhotos,
  onSaveDraft,
  onDiscard,
  onKeep,
}: {
  open: boolean;
  editing: boolean;
  hasPhotos: boolean;
  onSaveDraft: () => void;
  onDiscard: () => void;
  onKeep: () => void;
}) {
  const hint = editing
    ? 'Những thay đổi chưa lưu sẽ mất.'
    : hasPhotos
      ? 'Bản nháp giữ lại chữ, cảm xúc và ngày. Ảnh sẽ không được lưu.'
      : 'Bạn có thể quay lại viết tiếp bất cứ lúc nào.';
  return (
    <BottomSheet open={open} onClose={onKeep} title={editing ? 'Bỏ thay đổi?' : 'Lưu làm bản nháp?'}>
      <div className="stack">
        <p className="text-muted">{hint}</p>
        <div className="list">
          {!editing && (
            <button type="button" className="list__item" onClick={onSaveDraft}>
              <span className="list__body">
                <span className="list__label">Lưu bản nháp</span>
              </span>
            </button>
          )}
          <button type="button" className="list__item" onClick={onDiscard}>
            <span className="list__body">
              <span className="list__label text-danger">{editing ? 'Bỏ thay đổi' : 'Bỏ bài viết'}</span>
            </span>
          </button>
          <button type="button" className="list__item" onClick={onKeep}>
            <span className="list__body">
              <span className="list__label">Tiếp tục chỉnh sửa</span>
            </span>
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
