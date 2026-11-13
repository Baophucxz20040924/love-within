import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar } from '../../components/Avatar';
import { BottomSheet } from '../../components/BottomSheet';
import { FormError, useFormDismiss } from '../../components/useFormDismiss';
import { Icon } from '../../components/Icon';
import { Switch } from '../../components/Switch';
import { useToast } from '../../components/Toast';
import { ApiRequestError } from '../../lib/apiClient';
import type { FriendEventDetail, FriendEventInput } from '../../lib/types';
import { FRIEND_EVENTS_KEY, FRIENDS_OVERVIEW_KEY, friendEventKey, friendEventsApi, friendsApi, uploadFriendPhoto } from './api';
import { fromLocalInputs, plainName, toLocalInputs } from './eventFormat';

/** Limits of plan/FRIENDS_V2_PLAN.md BB5 (the server checks them again). */
const MAX_TITLE = 100;
const MAX_PLACE = 200;
const MAX_DESCRIPTION = 2000;
const MAX_INVITEES = 100;

type Cover = { kind: 'existing'; key: string; url: string; width: number; height: number } | { kind: 'new'; file: File; url: string } | null;

const errorText = (err: unknown) => (err instanceof ApiRequestError || err instanceof Error ? err.message : 'Có lỗi xảy ra, thử lại nhé.');

function tomorrowAt(time: string): { date: string; time: string } {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const [h, m] = time.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return toLocalInputs(d.toISOString());
}

interface Props {
  open: boolean;
  /** null = new event. */
  editing: FriendEventDetail | null;
  onClose: () => void;
  /** After saving (create or edit). */
  onSaved?: (ev: FriendEventDetail) => void;
}

/** "Lên kèo" / "Sửa kèo": details, cover photo, and the friends to invite (creator only; edit = "Mời thêm"). */
export function FriendEventSheet({ open, editing, onClose, onSaved }: Props) {
  if (!open) return null;
  return <EventForm key={editing?.id ?? 'new'} editing={editing} onClose={onClose} onSaved={onSaved} />;
}

function EventForm({ editing, onClose, onSaved }: Omit<Props, 'open'>) {
  const qc = useQueryClient();
  const toast = useToast();
  // Keep the opening baseline stable when a background refetch replaces the detail object.
  const [initial] = useState(() => {
    const start = editing ? toLocalInputs(editing.startAt) : tomorrowAt('19:00');
    const end = editing?.endAt ? toLocalInputs(editing.endAt) : { date: start.date, time: '' };
    return { start, end };
  });

  const [title, setTitle] = useState(editing?.title ?? '');
  const [date, setDate] = useState(initial.start.date);
  const [time, setTime] = useState(initial.start.time);
  const [hasEnd, setHasEnd] = useState(Boolean(editing?.endAt));
  const [endDate, setEndDate] = useState(initial.end.date);
  const [endTime, setEndTime] = useState(initial.end.time);
  const [place, setPlace] = useState(editing?.place ?? '');
  const [mapUrl, setMapUrl] = useState(editing?.mapUrl ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [cover, setCover] = useState<Cover>(editing?.cover ? { kind: 'existing', ...editing.cover } : null);
  const [initialDraft] = useState(() => JSON.stringify([
    title, date, time, hasEnd, endDate, endTime, place, mapUrl, description, cover?.kind === 'existing' ? cover.key : null,
  ]));
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { requestClose, discardPrompt } = useFormDismiss({
    open: true,
    dirty: picked.size > 0 || cover?.kind === 'new' || JSON.stringify([
      title, date, time, hasEnd, endDate, endTime, place, mapUrl, description, cover?.kind === 'existing' ? cover.key : null,
    ]) !== initialDraft,
    busy,
    onClose,
  });
  const fileRef = useRef<HTMLInputElement>(null);
  const coverRef = useRef(cover);
  coverRef.current = cover;

  useEffect(
    () => () => {
      if (coverRef.current?.kind === 'new') URL.revokeObjectURL(coverRef.current.url);
    },
    [],
  );

  const overview = useQuery({ queryKey: FRIENDS_OVERVIEW_KEY, queryFn: friendsApi.overview });
  const friends = overview.data?.friends ?? [];
  const invited = useMemo(() => new Set(editing?.invitedIds ?? []), [editing]);
  const filter = plainName(q);
  const shown = friends.filter((f) => !filter || plainName(f.user.displayName).includes(filter));
  const room = MAX_INVITEES - invited.size;
  const notInvited = friends.filter((f) => !invited.has(f.user.id));

  const startIso = fromLocalInputs(date, time);
  const endIso = hasEnd ? fromLocalInputs(endDate, endTime) : null;
  // Compared as typed (minutes), so opening and saving an event whose time has seconds does not move it.
  const startMoved = !editing || date !== initial.start.date || time !== initial.start.time;
  const endMoved = !editing || hasEnd !== Boolean(editing.endAt) || (hasEnd && (endDate !== initial.end.date || endTime !== initial.end.time));
  const problem = !title.trim()
    ? 'Hãy đặt tên cho kèo.'
    : !startIso
      ? 'Chọn ngày và giờ bắt đầu.'
      : startMoved && new Date(startIso).getTime() <= Date.now()
        ? 'Giờ bắt đầu phải ở tương lai.'
        : hasEnd && !endIso
          ? 'Chọn ngày và giờ kết thúc, hoặc tắt "Giờ kết thúc".'
          : endIso && new Date(endIso).getTime() <= new Date(startIso).getTime()
            ? 'Giờ kết thúc phải sau giờ bắt đầu.'
            : mapUrl.trim() && !/^https:\/\/\S+$/i.test(mapUrl.trim())
              ? 'Link bản đồ phải bắt đầu bằng https://'
              : null;

  function toggle(id: string) {
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else if (next.size < room) next.add(id);
      else toast.info(`Mỗi kèo mời tối đa ${MAX_INVITEES} người`);
      return next;
    });
  }

  function inviteAll() {
    const ids = notInvited.map((f) => f.user.id).slice(0, room);
    if (notInvited.length > room) toast.info(`Mỗi kèo mời tối đa ${MAX_INVITEES} người: đã chọn ${room} người đầu danh sách.`);
    setPicked(new Set(ids));
  }

  function onPickCover(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (busy || !file || !file.type.startsWith('image/')) return;
    if (cover?.kind === 'new') URL.revokeObjectURL(cover.url);
    setCover({ kind: 'new', file, url: URL.createObjectURL(file) });
  }

  function removeCover() {
    if (cover?.kind === 'new') URL.revokeObjectURL(cover.url);
    setCover(null);
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (problem || busy || !startIso) return;
    setBusy(true);
    setError(null);
    try {
      let coverInput: FriendEventInput['cover'] = null;
      if (cover?.kind === 'existing') coverInput = { key: cover.key, width: cover.width, height: cover.height };
      if (cover?.kind === 'new') coverInput = await uploadFriendPhoto(cover.file, friendEventsApi.uploadUrl);
      const input: FriendEventInput = {
        title: title.trim(),
        startAt: startIso,
        endAt: endIso,
        place: place.trim(),
        mapUrl: mapUrl.trim() || null,
        description: description.trim(),
        cover: coverInput,
      };
      let saved: FriendEventDetail;
      if (!editing) {
        saved = await friendEventsApi.create({ ...input, inviteeIds: [...picked] });
        toast.success(picked.size > 0 ? `Đã lên kèo và mời ${picked.size} người` : 'Đã lên kèo');
      } else {
        // Only what changed, so an unchanged time does not tell anyone.
        const patch: Partial<FriendEventInput> = {};
        if (input.title !== editing.title) patch.title = input.title;
        if (input.description !== editing.description) patch.description = input.description;
        if (startMoved) patch.startAt = input.startAt;
        if (endMoved) patch.endAt = input.endAt;
        if (input.place !== editing.place) patch.place = input.place;
        if (input.mapUrl !== editing.mapUrl) patch.mapUrl = input.mapUrl;
        if ((input.cover?.key ?? null) !== (editing.cover?.key ?? null)) patch.cover = input.cover;
        saved = Object.keys(patch).length > 0 ? await friendEventsApi.update(editing.id, patch) : editing;
        if (picked.size > 0) saved = await friendEventsApi.invite(editing.id, [...picked]);
        const moved = patch.startAt !== undefined || patch.endAt !== undefined || patch.place !== undefined || patch.mapUrl !== undefined;
        toast.success(moved ? 'Đã lưu. Những người Đi và Có thể sẽ được báo.' : 'Đã lưu thay đổi');
      }
      qc.setQueryData(friendEventKey(saved.id), saved);
      void qc.invalidateQueries({ queryKey: FRIEND_EVENTS_KEY });
      onSaved?.(saved);
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <BottomSheet open busy={busy} onClose={requestClose} title={editing ? 'Sửa kèo' : 'Lên kèo'}>
      {discardPrompt}
      <form className="form fev-form" onSubmit={(e) => void submit(e)}>
        <fieldset className="form" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }} disabled={busy}>
        <label className="field">
          <span className="field__label">Tên kèo</span>
          <input className="input" value={title} maxLength={MAX_TITLE} placeholder="Ví dụ: Đi ăn lẩu cuối tuần" onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="fev-form__row">
          <label className="field">
            <span className="field__label">Ngày</span>
            <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">Giờ bắt đầu</span>
            <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
        </div>
        <label className="fev-form__switch">
          <span>Giờ kết thúc</span>
          <Switch
            checked={hasEnd}
            onChange={(on) => {
              setHasEnd(on);
              if (on && !endTime) {
                setEndDate(date);
                const [h, m] = (time || '19:00').split(':').map(Number);
                setEndTime(`${String(Math.min(23, h + 2)).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
              }
            }}
          />
        </label>
        {hasEnd && (
          <div className="fev-form__row">
            <label className="field">
              <span className="field__label">Ngày kết thúc</span>
              <input className="input" type="date" value={endDate} min={date} onChange={(e) => setEndDate(e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">Giờ kết thúc</span>
              <input className="input" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
            </label>
          </div>
        )}
        <p className="field__hint fev-form__tz">Giờ theo điện thoại của bạn. Mỗi người thấy theo giờ máy của họ.</p>
        <label className="field">
          <span className="field__label">Địa điểm (tuỳ chọn)</span>
          <input className="input" value={place} maxLength={MAX_PLACE} placeholder="Tên quán, địa chỉ…" onChange={(e) => setPlace(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">Link bản đồ (tuỳ chọn)</span>
          <input
            className="input"
            type="url"
            inputMode="url"
            value={mapUrl}
            maxLength={500}
            placeholder="https://maps.app.goo.gl/…"
            onChange={(e) => setMapUrl(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field__label">Mô tả (tuỳ chọn)</span>
          <textarea
            className="input"
            rows={3}
            value={description}
            maxLength={MAX_DESCRIPTION}
            placeholder="Mang gì, ai đón ai…"
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        <div className="field">
          <span className="field__label">Ảnh bìa (tuỳ chọn)</span>
          {cover ? (
            <div className="fev-form__cover">
              <img src={cover.url} alt="Ảnh bìa" />
              <button type="button" className="composer__photo-remove" aria-label="Bỏ ảnh bìa" disabled={busy} onClick={removeCover}>
                <span>
                  <Icon name="x" size={16} />
                </span>
              </button>
            </div>
          ) : (
            <button type="button" className="btn btn-outline" disabled={busy} onClick={() => fileRef.current?.click()}>
              <Icon name="image" size={18} /> Thêm ảnh bìa
            </button>
          )}
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPickCover} />
        </div>

        <section className="fev-picker" aria-labelledby="fev-picker-title">
          <div className="fev-picker__head">
            <h3 id="fev-picker-title" className="field__label">
              {editing ? 'Mời thêm bạn bè' : 'Mời bạn bè'}
            </h3>
            <span className="text-sm text-muted">
              {editing ? `Đã mời ${invited.size}` : ''}
              {picked.size > 0 ? `${editing ? ' · ' : ''}Đã chọn ${picked.size}` : ''}
            </span>
          </div>
          {overview.isLoading && <p className="text-sm text-muted">Đang tải danh sách bạn bè…</p>}
          {overview.isError && (
            <p className="text-sm text-muted">
              Không tải được bạn bè.{' '}
              <button type="button" className="btn btn-ghost" onClick={() => void overview.refetch()}>
                Thử lại
              </button>
            </p>
          )}
          {overview.isSuccess && friends.length === 0 && <p className="text-sm text-muted">Bạn chưa có bạn bè nào để mời. Kết bạn trước nhé.</p>}
          {friends.length > 0 && (
            <>
              <div className="fev-picker__tools">
                <input
                  className="input"
                  type="search"
                  value={q}
                  placeholder="Tìm theo tên"
                  aria-label="Tìm bạn để mời"
                  onChange={(e) => setQ(e.target.value)}
                />
                <button type="button" className="btn btn-secondary fev-picker__all" disabled={notInvited.length === 0 || room <= 0} onClick={inviteAll}>
                  Mời tất cả bạn bè
                </button>
              </div>
              <ul className="fev-picker__list" aria-label="Bạn bè">
                {shown.map((f) => {
                  const already = invited.has(f.user.id);
                  const checked = already || picked.has(f.user.id);
                  return (
                    <li key={f.user.id}>
                      <label className={`fev-picker__item${already ? ' is-invited' : ''}`}>
                        <input type="checkbox" checked={checked} disabled={already} onChange={() => toggle(f.user.id)} />
                        <Avatar name={f.user.displayName} src={f.user.avatarUrl} size={36} />
                        <span className="fev-picker__name">{f.user.displayName}</span>
                        {already && <span className="chip">Đã mời</span>}
                      </label>
                    </li>
                  );
                })}
                {shown.length === 0 && <li className="text-sm text-muted fev-picker__none">Không có ai tên như vậy.</li>}
              </ul>
            </>
          )}
        </section>

        {problem && <p className="poll-editor__hint poll-editor__problem" role="status">{problem}</p>}
        <FormError error={error} />
        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={Boolean(problem) || busy}>
          {busy && <span className="spinner" aria-hidden="true" />}
          {editing ? 'Lưu' : 'Lên kèo'}
        </button>
        </fieldset>
      </form>
    </BottomSheet>
  );
}
