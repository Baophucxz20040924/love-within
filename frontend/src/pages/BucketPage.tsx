import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Icon } from '../components/Icon';
import { ProgressBar } from '../components/ProgressBar';
import { SegmentedControl } from '../components/SegmentedControl';
import { ErrorState, Page, Skeleton } from '../components/StatusViews';
import { useToast } from '../components/Toast';
import { bucketApi, bucketListKey, refreshBucket } from '../features/bucket/api';
import { BucketEmpty, BucketFormSheet, BucketItemSheet, CompleteSheet, IdeasSheet } from '../features/bucket/BucketSheets';
import { categoryInfo, dueText } from '../features/bucket/constants';
import { useCouplePeople } from '../features/questions/useCouplePeople';
import { ApiRequestError } from '../lib/apiClient';
import { formatDay } from '../lib/format';
import type { BucketItem, BucketStatus } from '../lib/types';

function BucketRow({ item, today, onOpen }: { item: BucketItem; today: string; onOpen: (it: BucketItem) => void }) {
  const due = item.status === 'todo' && item.dueOn ? dueText(item.dueOn, today) : null;
  const cat = categoryInfo(item.category);
  return (
    <button type="button" className={`list__item bk-row${item.status === 'done' ? ' bk-row--done' : ''}`} onClick={() => onOpen(item)}>
      <span className="ev-row__emoji" aria-hidden="true">
        {item.emoji}
      </span>
      <span className="list__body bk-row__body">
        <span className="list__label bk-row__title">{item.title}</span>
        <span className="list__meta">
          {item.status === 'done' && item.doneOn ? `Làm ngày ${formatDay(item.doneOn)}` : cat.label}
          {due && (
            <>
              {' · '}
              <span className={due.late ? 'text-danger' : undefined}>{due.text}</span>
            </>
          )}
        </span>
        {item.status === 'done' && (item.storyId || item.rewarded) && (
          <span className="ev-row__tags">
            {item.storyId && <span className="chip">Có kỷ niệm</span>} {item.rewarded && <span className="chip chip--brand">🪙 Đã nhận thưởng</span>}
          </span>
        )}
      </span>
      {item.pinned && item.status === 'todo' && (
        <span className="bk-row__pin" aria-label="Đã ghim">
          <Icon name="pin" size={18} />
        </span>
      )}
      {item.status === 'done' && (
        <span className="bk-row__check" aria-label="Đã làm">
          <Icon name="check" size={18} />
        </span>
      )}
    </button>
  );
}

/** /quests/bucket — "Bucket list chung" (CP3): Chưa làm / Đã làm, add, ideas, edit, pin, delete with undo, complete, reopen. */
export function BucketPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { today } = useCouplePeople();
  const [params, setParams] = useSearchParams();
  const tab: BucketStatus = params.get('tab') === 'done' ? 'done' : 'todo';
  const list = useQuery({ queryKey: bucketListKey(tab), queryFn: () => bucketApi.list(tab), staleTime: 0, refetchOnWindowFocus: true });

  const [form, setForm] = useState<{ open: boolean; editing: BucketItem | null }>({ open: false, editing: null });
  // Entry from a reached savings goal: open the existing composer, without replacing any text.
  useEffect(() => {
    if (params.get('compose') !== '1') return;
    setForm((current) => current.open ? current : { open: true, editing: null });
    setParams((current) => { const next = new URLSearchParams(current); next.delete('compose'); return next; }, { replace: true });
  }, [params, setParams]);
  const [ideasOpen, setIdeasOpen] = useState(false);
  const [detail, setDetail] = useState<BucketItem | null>(null);
  const [completing, setCompleting] = useState<BucketItem | null>(null);

  const restore = useMutation({
    mutationFn: (id: string) => bucketApi.restore(id),
    onSuccess: async () => {
      toast.success('Đã hoàn tác');
      await refreshBucket(qc);
    },
    onError: (err) => toast.error(err instanceof ApiRequestError ? err.message : 'Không hoàn tác được, thử lại nhé.'),
  });

  const remove = useMutation({
    mutationFn: (it: BucketItem) => bucketApi.remove(it.id).then(() => it),
    onSuccess: async (it) => {
      toast.action(`Đã xóa “${it.title}”`, { label: 'Hoàn tác', onClick: () => restore.mutate(it.id) });
      await refreshBucket(qc);
    },
    onError: (err) => toast.error(err instanceof ApiRequestError ? err.message : 'Không xóa được, thử lại nhé.'),
  });

  // Opened from the Quests tab (or a push): go back there; a direct link falls back to the Quests tab.
  const goBack = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate('/quests', { replace: true });
  };

  const counts = list.data?.counts;
  const total = counts ? counts.todo + counts.done : 0;
  const items = list.data?.items ?? [];

  return (
    <Page title="Bucket list" subtitle="Những điều muốn cùng nhau làm" onBack={goBack}>
      {counts && total > 0 && (
        <div className="card bk-summary">
          <div className="row row--between">
            <span className="strong">
              {counts.done}/{total} đã làm
            </span>
            <span className="text-sm text-muted">{counts.todo > 0 ? `Còn ${counts.todo} mục` : 'Xong hết rồi 🎉'}</span>
          </div>
          <ProgressBar value={(counts.done / total) * 100} tone="success" label="Đã làm" />
        </div>
      )}

      <div className="btn-row">
        <button type="button" className="btn btn-secondary" onClick={() => setIdeasOpen(true)}>
          💡 Gợi ý
        </button>
        <button type="button" className="btn btn-primary" onClick={() => setForm({ open: true, editing: null })}>
          <Icon name="plus" size={20} /> Thêm mục
        </button>
      </div>

      <SegmentedControl
        mode="group"
        ariaLabel="Trạng thái"
        value={tab}
        onChange={(v) => setParams((current) => {
          const next = new URLSearchParams(current);
          if (v === 'done') next.set('tab', 'done');
          else next.delete('tab');
          return next;
        }, { replace: true })}
        options={[
          { value: 'todo', label: counts ? `Chưa làm · ${counts.todo}` : 'Chưa làm' },
          { value: 'done', label: counts ? `Đã làm · ${counts.done}` : 'Đã làm' },
        ]}
      />

      {list.isLoading && <Skeleton height={64} count={4} />}
      {list.isError && <ErrorState onRetry={() => void list.refetch()} />}
      {list.isSuccess &&
        (items.length > 0 ? (
          <div className="list">
            {items.map((it) => (
              <BucketRow key={it.id} item={it} today={today} onOpen={setDetail} />
            ))}
          </div>
        ) : (
          <BucketEmpty done={tab === 'done'} onAdd={() => setForm({ open: true, editing: null })} onIdeas={() => setIdeasOpen(true)} />
        ))}

      <BucketItemSheet
        item={detail}
        onClose={() => setDetail(null)}
        onEdit={(it) => {
          setDetail(null);
          setForm({ open: true, editing: it });
        }}
        onComplete={(it) => {
          setDetail(null);
          setCompleting(it);
        }}
        onDelete={(it) => {
          setDetail(null);
          remove.mutate(it);
        }}
      />
      <BucketFormSheet open={form.open} editing={form.editing} onClose={() => setForm({ open: false, editing: null })} />
      <IdeasSheet open={ideasOpen} onClose={() => setIdeasOpen(false)} />
      <CompleteSheet item={completing} onClose={() => setCompleting(null)} />
    </Page>
  );
}
