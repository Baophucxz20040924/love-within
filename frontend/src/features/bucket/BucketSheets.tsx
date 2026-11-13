import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BottomSheet } from '../../components/BottomSheet';
import { FormError, useFormDismiss } from '../../components/useFormDismiss';
import { Icon } from '../../components/Icon';
import { EmptyState, ErrorState, Skeleton } from '../../components/StatusViews';
import { Switch } from '../../components/Switch';
import { useToast } from '../../components/Toast';
import { ApiRequestError } from '../../lib/apiClient';
import { formatDateTime, formatDay } from '../../lib/format';
import type { BucketCategory, BucketCompleteResult, BucketInput, BucketItem } from '../../lib/types';
import { useAuth } from '../auth/AuthContext';
import { useCouplePeople } from '../questions/useCouplePeople';
import { LEDGER_KEY, QUESTS_KEY, WALLET_KEY } from '../quests/api';
import { STORY_FEED_KEY, uploadStoryPhoto } from '../stories/api';
import { BUCKET_IDEAS_KEY, bucketApi, refreshBucket } from './api';
import { Celebration } from './Celebration';
import {
  BUCKET_CATEGORIES,
  BUCKET_DATE_MAX,
  BUCKET_EMOJIS,
  MAX_BUCKET_NOTE,
  MAX_BUCKET_PHOTOS,
  MAX_BUCKET_TITLE,
  categoryInfo,
  dueText,
} from './constants';

const errText = (err: unknown, fallback: string) => (err instanceof ApiRequestError || err instanceof Error ? err.message : fallback);

/** "Bạn" for me, the partner's short name otherwise. */
function useWho() {
  const { myId, partnerName } = useCouplePeople();
  return (id: string | null) => (id === myId ? 'Bạn' : partnerName);
}

function CategoryPicks({ value, onPick, labelId }: { value: BucketCategory; onPick: (c: BucketCategory) => void; labelId: string }) {
  return (
    <div className="ev-picks" role="radiogroup" aria-labelledby={labelId}>
      {BUCKET_CATEGORIES.map((c) => (
        <button
          key={c.value}
          type="button"
          role="radio"
          aria-checked={value === c.value}
          className={`quick-pick ev-pick${value === c.value ? ' is-active' : ''}`}
          onClick={() => onPick(c.value)}
        >
          <span aria-hidden="true">{c.emoji}</span> {c.label}
        </button>
      ))}
    </div>
  );
}

interface FormProps {
  open: boolean;
  onClose: () => void;
  /** null = new item. */
  editing: BucketItem | null;
}

/** Add or edit an item. Either member can do both. The emoji follows the category until one is picked. */
export function BucketFormSheet({ open, onClose, editing }: FormProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const { today } = useCouplePeople();
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<BucketCategory>('travel');
  const [emoji, setEmoji] = useState('✈️');
  const [emojiTouched, setEmojiTouched] = useState(false);
  const [note, setNote] = useState('');
  const [dueOn, setDueOn] = useState('');
  const [initialDraft, setInitialDraft] = useState('');

  useEffect(() => {
    if (!open) return;
    setTitle(editing?.title ?? '');
    setCategory(editing?.category ?? 'travel');
    setEmoji(editing?.emoji ?? '✈️');
    setEmojiTouched(Boolean(editing));
    setNote(editing?.note ?? '');
    setDueOn(editing?.dueOn ?? '');
    setInitialDraft(JSON.stringify([editing?.title ?? '', editing?.category ?? 'travel', editing?.emoji ?? '✈️', editing?.note ?? '', editing?.dueOn ?? '']));
    // Initialize per opening/record without overwriting drafts on a background refresh.
  }, [open, editing?.id]);

  function pickCategory(c: BucketCategory) {
    setCategory(c);
    if (!emojiTouched) setEmoji(categoryInfo(c).emoji);
  }

  const save = useMutation({
    mutationFn: () => {
      const input: BucketInput = { title: title.trim(), emoji, category, note: note.trim(), dueOn: dueOn || null };
      return editing ? bucketApi.update(editing.id, input) : bucketApi.create(input);
    },
    onSuccess: async () => {
      toast.success(editing ? 'Đã lưu thay đổi' : 'Đã thêm vào bucket list');
      onClose();
      await refreshBucket(qc);
    },
    onError: (err) => toast.error(errText(err, 'Có lỗi xảy ra, thử lại nhé.')),
  });

  useEffect(() => { save.reset(); }, [open, editing?.id]);

  const { requestClose, discardPrompt } = useFormDismiss({
    open,
    dirty: JSON.stringify([title, category, emoji, note, dueOn]) !== initialDraft,
    busy: save.isPending,
    onClose,
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (title.trim() && !save.isPending) save.mutate();
  }

  const emojis = BUCKET_EMOJIS.includes(emoji) ? BUCKET_EMOJIS : [emoji, ...BUCKET_EMOJIS.slice(0, -1)];

  return (
    <BottomSheet open={open} busy={save.isPending} onClose={requestClose} title={editing ? 'Sửa mục' : 'Thêm mục mới'}>
      {discardPrompt}
      <form className="form" onSubmit={onSubmit}>
        <fieldset className="form" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }} disabled={save.isPending}>
        <label className="field">
          <span className="field__label">Muốn cùng nhau làm gì?</span>
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={MAX_BUCKET_TITLE}
            placeholder="VD: Đi Đà Lạt ngắm hoa"
            required
          />
        </label>

        <div className="field">
          <span className="field__label" id="bk-cat-label">
            Nhóm
          </span>
          <CategoryPicks value={category} onPick={pickCategory} labelId="bk-cat-label" />
        </div>

        <div className="field">
          <span className="field__label" id="bk-emoji-label">
            Biểu tượng
          </span>
          <div className="emoji-grid" role="radiogroup" aria-labelledby="bk-emoji-label">
            {emojis.map((e) => (
              <button
                key={e}
                type="button"
                role="radio"
                aria-checked={emoji === e}
                aria-label={e}
                className={`emoji-pick${emoji === e ? ' is-active' : ''}`}
                onClick={() => {
                  setEmoji(e);
                  setEmojiTouched(true);
                }}
              >
                {e}
              </button>
            ))}
          </div>
        </div>

        <label className="field">
          <span className="field__label">Ghi chú (tuỳ chọn)</span>
          <textarea
            className="input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={MAX_BUCKET_NOTE}
            rows={3}
            placeholder="Đi mùa nào, cần chuẩn bị gì…"
          />
          <span className="char-count">
            {note.length}/{MAX_BUCKET_NOTE}
          </span>
        </label>

        <div className="field">
          <label className="field__label" htmlFor="bk-due">
            Hạn (tuỳ chọn)
          </label>
          <div className="bk-due">
            <input
              id="bk-due"
              className="input"
              type="date"
              value={dueOn}
              min={editing?.dueOn && editing.dueOn < today ? editing.dueOn : today}
              max={BUCKET_DATE_MAX}
              onChange={(e) => setDueOn(e.target.value)}
            />
            {dueOn && (
              <button type="button" className="btn btn-ghost" onClick={() => setDueOn('')}>
                Bỏ hạn
              </button>
            )}
          </div>
        </div>

        <FormError error={save.error} />
        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={!title.trim() || save.isPending}>
          {save.isPending ? <span className="spinner" aria-hidden="true" /> : null}
          {editing ? 'Lưu thay đổi' : 'Thêm vào danh sách'}
        </button>
        </fieldset>
      </form>
    </BottomSheet>
  );
}

/** "Gợi ý": about 60 ideas by category; tap one to add it at once. */
export function IdeasSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const ideas = useQuery({ queryKey: BUCKET_IDEAS_KEY, queryFn: bucketApi.ideas, enabled: open, staleTime: 0 });
  const [cat, setCat] = useState<BucketCategory | 'all'>('all');
  const [adding, setAdding] = useState<string | null>(null);

  async function add(ideaId: string, title: string) {
    setAdding(ideaId);
    try {
      await bucketApi.create({ ideaId });
      toast.success(`Đã thêm “${title}”`);
      await refreshBucket(qc);
    } catch (err) {
      toast.error(errText(err, 'Không thêm được, thử lại nhé.'));
    } finally {
      setAdding(null);
    }
  }

  const shown = (ideas.data?.ideas ?? []).filter((i) => cat === 'all' || i.category === cat);

  return (
    <BottomSheet open={open} onClose={onClose} title="Gợi ý cho hai bạn">
      <div className="stack">
        <div className="bk-cats" role="radiogroup" aria-label="Nhóm gợi ý">
          {[{ value: 'all' as const, label: 'Tất cả', emoji: '💡' }, ...BUCKET_CATEGORIES].map((c) => (
            <button
              key={c.value}
              type="button"
              role="radio"
              aria-checked={cat === c.value}
              className={`quick-pick ev-pick${cat === c.value ? ' is-active' : ''}`}
              onClick={() => setCat(c.value)}
            >
              <span aria-hidden="true">{c.emoji}</span> {c.label}
            </button>
          ))}
        </div>
        {ideas.isLoading && <Skeleton height={56} count={5} />}
        {ideas.isError && <ErrorState onRetry={() => void ideas.refetch()} />}
        {ideas.isSuccess && (
          <div className="list bk-ideas">
            {shown.map((i) => (
              <button
                key={i.id}
                type="button"
                className="list__item"
                disabled={i.added || adding !== null}
                aria-label={i.added ? `${i.title}, đã thêm` : `Thêm ${i.title}`}
                onClick={() => void add(i.id, i.title)}
              >
                <span className="ev-row__emoji" aria-hidden="true">
                  {i.emoji}
                </span>
                <span className="list__body">
                  <span className="list__label bk-row__title">{i.title}</span>
                  <span className="list__meta" style={{ display: 'block' }}>
                    {categoryInfo(i.category).label}
                  </span>
                </span>
                {i.added ? (
                  <span className="chip chip--success">
                    <Icon name="check" size={14} /> Đã thêm
                  </span>
                ) : adding === i.id ? (
                  <span className="spinner" aria-hidden="true" />
                ) : (
                  <span className="bk-add" aria-hidden="true">
                    <Icon name="plus" size={20} />
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        <p className="field__hint center">Gợi ý là bản nháp, sẽ còn được chỉnh sửa và bổ sung.</p>
      </div>
    </BottomSheet>
  );
}

interface ItemProps {
  item: BucketItem | null;
  onClose: () => void;
  onEdit: (it: BucketItem) => void;
  onComplete: (it: BucketItem) => void;
  onDelete: (it: BucketItem) => void;
}

/** One item: details and what can be done with it (complete, edit, pin, reopen, delete). */
export function BucketItemSheet({ item, onClose, onEdit, onComplete, onDelete }: ItemProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const who = useWho();
  const { today } = useCouplePeople();

  const pin = useMutation({
    mutationFn: (it: BucketItem) => bucketApi.update(it.id, { pinned: !it.pinned }),
    onSuccess: async (it) => {
      toast.success(it.pinned ? 'Đã ghim lên đầu danh sách' : 'Đã bỏ ghim');
      onClose();
      await refreshBucket(qc);
    },
    onError: (err) => toast.error(errText(err, 'Có lỗi xảy ra, thử lại nhé.')),
  });

  const reopen = useMutation({
    mutationFn: (it: BucketItem) => bucketApi.reopen(it.id),
    onSuccess: async (it) => {
      toast.info(`Đã chuyển “${it.title}” về Chưa làm`);
      onClose();
      await refreshBucket(qc);
    },
    onError: (err) => toast.error(errText(err, 'Có lỗi xảy ra, thử lại nhé.')),
  });

  const cat = item ? categoryInfo(item.category) : null;
  const due = item?.dueOn && item.status === 'todo' ? dueText(item.dueOn, today) : null;

  return (
    <BottomSheet open={item !== null} onClose={onClose} title={item?.status === 'done' ? 'Đã làm' : 'Chưa làm'}>
      {item && cat && (
        <div className="stack">
          <div className="ev-detail">
            <span className="ev-detail__emoji" aria-hidden="true">
              {item.emoji}
            </span>
            <p className="ev-detail__title">{item.title}</p>
            <p className="text-muted">
              {cat.emoji} {cat.label}
              {item.pinned && item.status === 'todo' ? ' · Đã ghim' : ''}
            </p>
            {due && <span className={`chip ${due.late ? 'chip--danger' : 'chip--brand'}`}>{due.text}</span>}
            {item.status === 'done' && item.doneOn && (
              <span className="chip chip--success">
                <Icon name="check" size={14} /> {who(item.doneBy)} đánh dấu xong · {formatDay(item.doneOn)}
              </span>
            )}
          </div>
          {item.note && <p className="ev-detail__note">{item.note}</p>}
          {item.status === 'done' && item.doneNote && <p className="ev-detail__note bk-feeling">“{item.doneNote}”</p>}

          {item.status === 'todo' && (
            <button type="button" className="btn btn-primary btn-lg btn-block" onClick={() => onComplete(item)}>
              Đã làm xong 🎉
            </button>
          )}

          <div className="list">
            {item.status === 'done' && item.storyId && (
              <Link to={`/stories/${encodeURIComponent(item.storyId)}`} className="list__item">
                <span className="icon-tile icon-tile--neutral" aria-hidden="true">
                  <Icon name="bookOpen" size={20} />
                </span>
                <span className="list__body">
                  <span className="list__label">Xem kỷ niệm</span>
                </span>
                <Icon name="chevronRight" className="text-muted" />
              </Link>
            )}
            {item.status === 'done' && item.reopenUntil && (
              <button type="button" className="list__item" disabled={reopen.isPending} onClick={() => reopen.mutate(item)}>
                <span className="icon-tile icon-tile--neutral" aria-hidden="true">
                  <Icon name="undo" size={20} />
                </span>
                <span className="list__body">
                  <span className="list__label">Đánh dấu chưa làm</span>
                  <span className="list__meta" style={{ display: 'block' }}>
                    Được tới {formatDateTime(item.reopenUntil)}. Bài Story vẫn giữ nguyên.
                  </span>
                </span>
              </button>
            )}
            <button type="button" className="list__item" onClick={() => onEdit(item)}>
              <span className="icon-tile icon-tile--neutral" aria-hidden="true">
                <Icon name="edit" size={20} />
              </span>
              <span className="list__body">
                <span className="list__label">Sửa</span>
              </span>
            </button>
            {item.status === 'todo' && (
              <button type="button" className="list__item" disabled={pin.isPending} onClick={() => pin.mutate(item)}>
                <span className="icon-tile icon-tile--neutral" aria-hidden="true">
                  <Icon name="pin" size={20} />
                </span>
                <span className="list__body">
                  <span className="list__label">{item.pinned ? 'Bỏ ghim' : 'Ghim lên đầu'}</span>
                </span>
              </button>
            )}
            <button type="button" className="list__item" onClick={() => onDelete(item)}>
              <span className="icon-tile icon-tile--neutral" aria-hidden="true">
                <Icon name="trash" size={20} />
              </span>
              <span className="list__body">
                <span className="list__label text-danger">Xóa</span>
              </span>
            </button>
          </div>
          <p className="field__hint center">
            {who(item.createdBy)} thêm · {formatDay(item.createdAt.slice(0, 10))}
          </p>
        </div>
      )}
    </BottomSheet>
  );
}

type Photo = { id: string; file: File; url: string };
let seq = 0;

/** Reward line of the result: "+30 Xu · +20 EXP" or why there was none. */
function RewardLine({ result }: { result: BucketCompleteResult }) {
  if (result.reward) {
    return (
      <div className="quest-card__rewards bk-reward" aria-label={`Nhận thưởng ${result.reward.coin} Xu và ${result.reward.exp} EXP`}>
        <span className="chip chip--brand">🪙 +{result.reward.coin} Xu</span>
        <span className="chip chip--brand">✨ +{result.reward.exp} EXP</span>
        {result.reward.leveledUp && <span className="chip chip--success">Lên cấp 🎉</span>}
      </div>
    );
  }
  return result.rewardSkipped ? <p className="text-sm text-muted center">{result.rewardSkipped.message}</p> : null;
}

/**
 * "Đã làm xong 🎉": day it was done (today by default, never in the future), feeling, photos and "Đăng lên Story" (on).
 * Then the result: reward or why there was none, "Xem kỷ niệm", and a short celebration (not with reduced motion).
 */
export function CompleteSheet({ item, onClose }: { item: BucketItem | null; onClose: () => void }) {
  if (!item) return null;
  return <CompleteSheetBody key={item.id} item={item} onClose={onClose} />;
}

function CompleteSheetBody({ item, onClose }: { item: BucketItem; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { refreshMe } = useAuth();
  const { today } = useCouplePeople();
  const [initialDay] = useState(today);
  const [doneOn, setDoneOn] = useState(initialDay);
  const [note, setNote] = useState('');
  const [postStory, setPostStory] = useState(true);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BucketCompleteResult | null>(null);
  const [party, setParty] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploaded = useRef(new Map<string, { key: string; width: number; height: number }>());
  const photosRef = useRef(photos);
  photosRef.current = photos;

  useEffect(() => () => photosRef.current.forEach((p) => URL.revokeObjectURL(p.url)), []);

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith('image/'));
    e.target.value = '';
    if (busy) return;
    const room = MAX_BUCKET_PHOTOS - photos.length;
    if (files.length > room) toast.info(`Tối đa ${MAX_BUCKET_PHOTOS} ảnh`);
    const added = files.slice(0, Math.max(0, room)).map((file) => ({ id: `bp${++seq}`, file, url: URL.createObjectURL(file) }));
    if (added.length) setPhotos((ps) => [...ps, ...added]);
  }

  function removePhoto(id: string) {
    const p = photos.find((x) => x.id === id);
    if (p) URL.revokeObjectURL(p.url);
    uploaded.current.delete(id);
    setPhotos((ps) => ps.filter((x) => x.id !== id));
  }

  const validDay = /^\d{4}-\d{2}-\d{2}$/.test(doneOn) && doneOn <= today && doneOn >= item.doneOnMin;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !validDay) return;
    setError(null);
    setBusy(true);
    try {
      const out: { key: string; width: number; height: number }[] = [];
      if (postStory) {
        let n = 0;
        for (const p of photos) {
          n += 1;
          let up = uploaded.current.get(p.id);
          if (!up) {
            setStatus(`Đang tải ảnh ${n}/${photos.length}…`);
            up = await uploadStoryPhoto(p.file);
            uploaded.current.set(p.id, up);
          }
          out.push(up);
        }
      }
      setStatus('Đang lưu…');
      const r = await bucketApi.complete(item.id, { doneOn, note: note.trim(), photos: out, postStory });
      setResult(r);
      setParty((x) => x + 1);
      // No toast: the result view shows the reward line, and a toast would cover its "Xem kỷ niệm" button.
      const jobs: Promise<unknown>[] = [refreshBucket(qc)];
      if (r.story) jobs.push(qc.invalidateQueries({ queryKey: STORY_FEED_KEY }));
      if (r.reward) {
        jobs.push(
          qc.invalidateQueries({ queryKey: WALLET_KEY }),
          qc.invalidateQueries({ queryKey: LEDGER_KEY }),
          qc.invalidateQueries({ queryKey: QUESTS_KEY }),
          refreshMe(),
        );
      }
      await Promise.all(jobs);
    } catch (err) {
      setError(errText(err, 'Không lưu được, thử lại nhé.'));
      toast.error(errText(err, 'Không lưu được, thử lại nhé.'));
      if (err instanceof ApiRequestError && (err.code === 'BUCKET_ALREADY_DONE' || err.status === 404)) {
        await refreshBucket(qc);
        onClose();
      }
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }

  const { requestClose, discardPrompt } = useFormDismiss({
    open: true,
    dirty: !result && (doneOn !== initialDay || note !== '' || !postStory || photos.length > 0),
    busy,
    onClose,
  });

  return (
    <>
      <BottomSheet open busy={busy} onClose={requestClose} title={result ? 'Tuyệt vời!' : 'Đã làm xong 🎉'}>
        {discardPrompt}
        {result ? (
          <div className="stack bk-result">
            <span className="bk-result__art" aria-hidden="true">
              🎉
            </span>
            <p className="ev-detail__title center">
              Hai bạn đã làm xong “{result.item.title}”
            </p>
            <RewardLine result={result} />
            {result.story && (
              <Link to={`/stories/${encodeURIComponent(result.story.id)}`} className="btn btn-outline btn-block" aria-disabled={busy || undefined} onClick={(e) => { if (busy) e.preventDefault(); }}>
                <Icon name="bookOpen" size={18} /> Xem kỷ niệm
              </Link>
            )}
            <button type="button" className="btn btn-primary btn-block" disabled={busy} onClick={requestClose}>
              Xong
            </button>
          </div>
        ) : (
          <form className="form" onSubmit={(e) => void submit(e)}>
            <fieldset className="form" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }} disabled={busy}>
            <p className="bk-done-title">
              <span aria-hidden="true">{item.emoji}</span> {item.title}
            </p>
            <label className="field">
              <span className="field__label">Ngày làm</span>
              <input
                className="input"
                type="date"
                value={doneOn}
                min={item.doneOnMin}
                max={today}
                onChange={(e) => setDoneOn(e.target.value)}
                required
              />
              {!validDay && doneOn !== '' && (
                <span className="field__hint text-danger">{doneOn > today ? 'Ngày làm không thể ở tương lai' : `Ngày làm không thể trước ${formatDay(item.doneOnMin)}`}</span>
              )}
            </label>

            <label className="field">
              <span className="field__label">Cảm nhận (tuỳ chọn)</span>
              <textarea
                className="input"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={MAX_BUCKET_NOTE}
                rows={3}
                placeholder="Điều gì đáng nhớ nhất?"
              />
              <span className="char-count">
                {note.length}/{MAX_BUCKET_NOTE}
              </span>
            </label>

            <label className="ev-toggle">
              <span className="ev-toggle__text">
                <span className="ev-toggle__label">Đăng lên Story</span>
                <span className="field__hint">{postStory ? 'Thành một kỷ niệm của hai bạn, kèm ảnh' : 'Chỉ đánh dấu đã làm, không đăng bài'}</span>
              </span>
              <Switch checked={postStory} onChange={setPostStory} disabled={busy} />
            </label>

            {postStory && (
              <div className="field">
                <span className="field__label">
                  Ảnh (tuỳ chọn, tối đa {MAX_BUCKET_PHOTOS})
                </span>
                <div className="composer__photos bk-photos">
                  {photos.map((p) => (
                    <div key={p.id} className="composer__photo">
                      <img src={p.url} alt="" />
                      <button type="button" className="composer__photo-remove" aria-label="Bỏ ảnh này" disabled={busy} onClick={() => removePhoto(p.id)}>
                        <span>
                          <Icon name="x" size={16} />
                        </span>
                      </button>
                    </div>
                  ))}
                  {photos.length < MAX_BUCKET_PHOTOS && (
                    <button type="button" className="composer__add" aria-label="Thêm ảnh" disabled={busy} onClick={() => fileRef.current?.click()}>
                      <Icon name="image" size={24} />
                    </button>
                  )}
                </div>
                <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={onPick} />
              </div>
            )}

            {item.rewarded ? (
              <p className="text-sm text-muted">Mục này đã nhận thưởng trước đây.</p>
            ) : (
              <p className="text-sm text-muted">Mỗi mục thưởng 30 Xu + 20 EXP một lần, khi đã thêm từ 24 giờ trước. Tối đa 2 mục mỗi ngày.</p>
            )}
            {status && (
              <p className="composer__status" role="status">
                {status}
              </p>
            )}
            <FormError error={error} />
            <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy || !validDay}>
              {busy ? <span className="spinner" aria-hidden="true" /> : null}
              Lưu
            </button>
            </fieldset>
          </form>
        )}
      </BottomSheet>
      {party > 0 && <Celebration key={party} />}
    </>
  );
}

/** Empty list of a tab. */
export function BucketEmpty({ done, onAdd, onIdeas }: { done: boolean; onAdd: () => void; onIdeas: () => void }) {
  if (done) {
    return (
      <div className="card">
        <EmptyState art="🎯" title="Chưa có mục nào làm xong" hint="Làm xong một mục thì bấm “Đã làm xong 🎉” để lưu thành kỷ niệm." />
      </div>
    );
  }
  return (
    <div className="card">
      <EmptyState
        art="🪣"
        title="Danh sách còn trống"
        hint="Thêm những điều hai bạn muốn cùng làm, hoặc chọn từ gợi ý."
        action={
          <div className="btn-row">
            <button type="button" className="btn btn-secondary" onClick={onIdeas}>
              Xem gợi ý
            </button>
            <button type="button" className="btn btn-primary" onClick={onAdd}>
              Thêm mục
            </button>
          </div>
        }
      />
    </div>
  );
}
