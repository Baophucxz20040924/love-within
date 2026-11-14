import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BottomSheet } from '../../components/BottomSheet';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { ApiRequestError } from '../../lib/apiClient';
import { shortName } from '../../lib/format';
import type { ReportReason, ReportTarget } from '../../lib/types';
import { friendsApi } from './api';
import { removeAuthorFromCache } from './cache';

const errorText = (err: unknown) => (err instanceof ApiRequestError ? err.message : 'Có lỗi xảy ra, thử lại nhé.');

export const REPORT_REASONS: { value: ReportReason; label: string }[] = [
  { value: 'spam', label: 'Spam' },
  { value: 'harassment', label: 'Quấy rối hoặc bắt nạt' },
  { value: 'sensitive', label: 'Nội dung nhạy cảm' },
  { value: 'violence', label: 'Bạo lực hoặc đe dọa' },
  { value: 'fake', label: 'Giả mạo' },
  { value: 'other', label: 'Khác' },
];

const WHAT: Record<ReportTarget, string> = { story: 'bài viết', comment: 'bình luận', user: 'tài khoản', event: 'kèo', event_comment: 'bình luận' };

export interface ReportTargetInfo {
  type: ReportTarget;
  id: string;
  /** Author of the post/comment, or the reported person. */
  owner: { id: string; displayName: string };
}

interface ReportProps {
  target: ReportTargetInfo | null;
  onClose: () => void;
  /** After sending: offer to block the person. */
  onBlock?: (owner: { id: string; displayName: string }) => void;
  /** After sending a post report: offer to hide the post from my feed. */
  onHide?: () => void;
}

/** "Báo cáo": pick a reason (+ optional note). The reported person never learns who reported them. */
export function ReportSheet({ target, onClose, onBlock, onHide }: ReportProps) {
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState('');
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (!target) return;
    setReason(null);
    setNote('');
    setSent(false);
  }, [target]);

  const send = useMutation({
    mutationFn: () => friendsApi.report({ targetType: target!.type, targetId: target!.id, reason: reason!, note }),
    onSuccess: () => setSent(true),
  });

  useEffect(() => {
    if (target && send.isError) send.reset();
  }, [target, send.reset]);

  if (!target) return null;
  const name = shortName(target.owner.displayName);

  return (
    <BottomSheet open onClose={onClose} title={sent ? 'Đã gửi báo cáo' : `Báo cáo ${WHAT[target.type]}`}>
      {sent ? (
        <div className="stack">
          <p className="text-muted">Cảm ơn bạn. Chúng mình sẽ xem xét. {name} sẽ không biết ai đã báo cáo.</p>
          <div className="list">
            {onHide && (
              <button
                type="button"
                className="list__item"
                onClick={() => {
                  onClose();
                  onHide();
                }}
              >
                <span className="icon-tile icon-tile--neutral" aria-hidden="true">
                  <Icon name="eyeOff" size={20} />
                </span>
                <span className="list__body">
                  <span className="list__label">Ẩn bài viết này</span>
                </span>
              </button>
            )}
            {onBlock && (
              <button
                type="button"
                className="list__item"
                onClick={() => {
                  onClose();
                  onBlock(target.owner);
                }}
              >
                <span className="icon-tile icon-tile--neutral" aria-hidden="true">
                  <Icon name="shield" size={20} />
                </span>
                <span className="list__body">
                  <span className="list__label text-danger">Chặn {name}</span>
                </span>
              </button>
            )}
          </div>
          <button type="button" className="btn btn-secondary btn-block" onClick={onClose}>
            Xong
          </button>
        </div>
      ) : (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason) send.mutate();
          }}
        >
          <fieldset className="report-reasons">
            <legend className="field__label">Vấn đề là gì?</legend>
            <div className="list">
              {REPORT_REASONS.map((r) => (
                <label key={r.value} className="list__item report-reason">
                  <input type="radio" name="report-reason" value={r.value} checked={reason === r.value} onChange={() => setReason(r.value)} />
                  <span className="list__body">
                    <span className="list__label">{r.label}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="field">
            <span className="field__label">Ghi chú (không bắt buộc)</span>
            <textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} placeholder="Kể thêm nếu cần" />
          </label>
          {send.isError && <p className="form-feedback" role="alert">{errorText(send.error)}</p>}
          <button type="submit" className="btn btn-danger btn-lg btn-block" disabled={!reason || send.isPending}>
            {send.isPending && <span className="spinner" aria-hidden="true" />}
            Gửi báo cáo
          </button>
        </form>
      )}
    </BottomSheet>
  );
}

interface BlockProps {
  user: { id: string; displayName: string } | null;
  onClose: () => void;
  onBlocked?: () => void;
}

/** "Chặn": both stop seeing each other; the blocked person is not told. */
export function BlockSheet({ user, onClose, onBlocked }: BlockProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const block = useMutation({
    mutationFn: (id: string) => friendsApi.block(id),
    onSuccess: async (_r, id) => {
      removeAuthorFromCache(qc, id);
      toast.info(`Đã chặn ${user ? shortName(user.displayName) : ''}`);
      onClose();
      onBlocked?.();
      await qc.invalidateQueries({ queryKey: ['friends'] });
    },
  });

  useEffect(() => {
    if (user && block.isError) block.reset();
  }, [user, block.reset]);

  if (!user) return null;
  const name = shortName(user.displayName);
  return (
    <BottomSheet open onClose={onClose} title={`Chặn ${user.displayName}?`}>
      <div className="stack">
        <ul className="bullets">
          <li>Hai bạn sẽ không còn là bạn bè và không tìm thấy nhau.</li>
          <li>Không ai xem được bài viết, bình luận của người kia.</li>
          <li>{name} sẽ không được báo là bạn đã chặn.</li>
        </ul>
        <p className="text-sm text-muted">Bạn có thể bỏ chặn ở Tôi → Đã chặn.</p>
        {block.isError && <p className="form-feedback" role="alert">{errorText(block.error)}</p>}
        <div className="btn-row">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Hủy
          </button>
          <button type="button" className="btn btn-danger" disabled={block.isPending} onClick={() => block.mutate(user.id)}>
            Chặn
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
