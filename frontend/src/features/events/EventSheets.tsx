import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BottomSheet } from '../../components/BottomSheet';
import { FormError, useFormDismiss } from '../../components/useFormDismiss';
import { Icon } from '../../components/Icon';
import { Switch } from '../../components/Switch';
import { useToast } from '../../components/Toast';
import { ApiRequestError } from '../../lib/apiClient';
import { formatDay, shortName } from '../../lib/format';
import type { CoupleEvent, EventInput, EventKind } from '../../lib/types';
import { useAuth } from '../auth/AuthContext';
import { inOpenRange, nextYearlyAfter } from '../letters/openDates';
import { useCouplePeople } from '../questions/useCouplePeople';
import { eventsApi, refreshEvents } from './api';
import {
  EVENT_DATE_MAX,
  EVENT_DATE_MIN,
  EVENT_EMOJIS,
  EVENT_KINDS,
  MAX_EVENT_NOTE,
  MAX_EVENT_TITLE,
  daysLeftText,
  defaultRepeat,
  eventDayText,
  kindInfo,
} from './constants';
import { CountdownCells, useNow } from './Countdown';
import { downloadIcs } from './ics';

const capitalize = (s: string) => s.charAt(0).toLocaleUpperCase('vi') + s.slice(1);

/** Me and my partner as birthday people: id + the short name used in "Sinh nhật Hà". */
function usePeople() {
  const { myId, myName, partnerId, partnerName } = useCouplePeople();
  const nameOf = (id: string | null) => (id === myId ? shortName(myName) : partnerName);
  return { myId, partnerId, partnerName, nameOf };
}

interface FormProps {
  open: boolean;
  onClose: () => void;
  /** null = new event. */
  editing: CoupleEvent | null;
}

/**
 * Add or edit an event. Either member can do both, no approval needed. While a field still holds its automatic value
 * (title "Sinh nhật Hà", the kind's emoji, the kind's repeat), switching kind or person updates it.
 */
export function EventFormSheet({ open, onClose, editing }: FormProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const { myId, partnerId, partnerName, nameOf } = usePeople();

  const [kind, setKind] = useState<EventKind>('birthday');
  const [personId, setPersonId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [autoTitle, setAutoTitle] = useState('');
  const [emoji, setEmoji] = useState('🎂');
  const [emojiTouched, setEmojiTouched] = useState(false);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [yearly, setYearly] = useState(true);
  const [repeatTouched, setRepeatTouched] = useState(false);
  const [note, setNote] = useState('');
  const [remind, setRemind] = useState(true);
  const [initialDraft, setInitialDraft] = useState('');

  const birthdayTitle = (id: string | null) => `Sinh nhật ${nameOf(id)}`;

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setKind(editing.kind);
      setPersonId(editing.personId);
      setTitle(editing.title);
      setAutoTitle('');
      setEmoji(editing.emoji);
      setEmojiTouched(true);
      setDate(editing.date);
      setTime(editing.time ?? '');
      setYearly(editing.repeat === 'yearly');
      setRepeatTouched(true);
      setNote(editing.note);
      setRemind(editing.remind);
    } else {
      const first = birthdayTitle(partnerId);
      setKind('birthday');
      setPersonId(partnerId);
      setTitle(first);
      setAutoTitle(first);
      setEmoji(kindInfo('birthday').emoji);
      setEmojiTouched(false);
      setDate('');
      setTime('');
      setYearly(true);
      setRepeatTouched(false);
      setNote('');
      setRemind(true);
    }
    setInitialDraft(JSON.stringify(editing
      ? [editing.kind, editing.personId, editing.title, editing.emoji, editing.date, editing.time ?? '', editing.repeat === 'yearly', editing.note, editing.remind]
      : ['birthday', partnerId, birthdayTitle(partnerId), kindInfo('birthday').emoji, '', '', true, '', true]));
    // Initialize per opening/record, not when a background refresh replaces the same record.
  }, [open, editing?.id]);

  /** Replace the title only while it is empty or still the automatic one. */
  function syncTitle(next: string) {
    if (title.trim() === '' || title === autoTitle) setTitle(next);
    setAutoTitle(next);
  }

  function pickKind(k: EventKind) {
    setKind(k);
    if (!emojiTouched) setEmoji(kindInfo(k).emoji);
    if (!repeatTouched) setYearly(defaultRepeat(k) === 'yearly');
    const person = personId ?? partnerId;
    if (k === 'birthday') setPersonId(person);
    syncTitle(k === 'birthday' ? birthdayTitle(person) : '');
  }

  function pickPerson(id: string | null) {
    setPersonId(id);
    syncTitle(birthdayTitle(id));
  }

  const save = useMutation({
    mutationFn: () => {
      const input: EventInput = {
        title: title.trim(),
        emoji,
        kind,
        personId: kind === 'birthday' ? personId : null,
        date,
        time: time || null,
        repeat: yearly ? 'yearly' : 'none',
        note: note.trim(),
        remind,
      };
      return editing ? eventsApi.update(editing.id, input) : eventsApi.create(input);
    },
    onSuccess: async () => {
      toast.success(editing ? 'Đã lưu thay đổi' : `Đã thêm sự kiện. ${partnerName} cũng thấy trong danh sách.`);
      onClose();
      await refreshEvents(qc);
    },
    onError: (err) => toast.error(err instanceof ApiRequestError ? err.message : 'Có lỗi xảy ra, thử lại nhé.'),
  });

  useEffect(() => { save.reset(); }, [open, editing?.id]);

  const { requestClose, discardPrompt } = useFormDismiss({
    open,
    dirty: JSON.stringify([kind, personId, title, emoji, date, time, yearly, note, remind]) !== initialDraft,
    busy: save.isPending,
    onClose,
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!valid || save.isPending) return;
    save.mutate();
  }

  const emojis = EVENT_EMOJIS.includes(emoji) ? EVENT_EMOJIS : [emoji, ...EVENT_EMOJIS.slice(0, -1)];
  const valid = title.trim().length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date) && (kind !== 'birthday' || personId !== null);

  return (
    <BottomSheet open={open} busy={save.isPending} onClose={requestClose} title={editing ? 'Sửa sự kiện' : 'Thêm sự kiện'}>
      {discardPrompt}
      <form className="form" onSubmit={onSubmit}>
        <fieldset className="form" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }} disabled={save.isPending}>
        <div className="field">
          <span className="field__label" id="ev-kind-label">
            Loại
          </span>
          <div className="ev-picks" role="radiogroup" aria-labelledby="ev-kind-label">
            {EVENT_KINDS.map((k) => (
              <button
                key={k.value}
                type="button"
                role="radio"
                aria-checked={kind === k.value}
                className={`quick-pick ev-pick${kind === k.value ? ' is-active' : ''}`}
                onClick={() => pickKind(k.value)}
              >
                <span aria-hidden="true">{k.emoji}</span> {k.label}
              </button>
            ))}
          </div>
        </div>

        {kind === 'birthday' && (
          <div className="field">
            <span className="field__label" id="ev-person-label">
              Sinh nhật của
            </span>
            <div className="ev-picks ev-picks--two" role="radiogroup" aria-labelledby="ev-person-label">
              {[
                { id: partnerId, label: partnerName },
                { id: myId, label: 'Bạn' },
              ].map((p) => (
                <button
                  key={p.id ?? 'partner'}
                  type="button"
                  role="radio"
                  aria-checked={personId === p.id}
                  className={`quick-pick ev-pick${personId === p.id ? ' is-active' : ''}`}
                  onClick={() => pickPerson(p.id)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <label className="field">
          <span className="field__label">Tên sự kiện</span>
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={MAX_EVENT_TITLE}
            placeholder="VD: Đi Phú Quốc"
            required
          />
        </label>

        <div className="field">
          <span className="field__label" id="ev-emoji-label">
            Biểu tượng
          </span>
          <div className="emoji-grid" role="radiogroup" aria-labelledby="ev-emoji-label">
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

        <div className="ev-when">
          <label className="field">
            <span className="field__label">{kind === 'birthday' ? 'Ngày sinh' : 'Ngày'}</span>
            <input
              className="input"
              type="date"
              value={date}
              min={EVENT_DATE_MIN}
              max={EVENT_DATE_MAX}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </label>
          <label className="field">
            <span className="field__label">Giờ (tuỳ chọn)</span>
            <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>
        </div>
        {time && (
          <div className="ev-time-note">
            <p className="field__hint">
              {kind === 'meet' ? 'Trang chủ sẽ đếm ngược tới từng phút.' : `Giờ theo múi giờ của hai bạn.`}
            </p>
            <button type="button" className="btn btn-ghost" onClick={() => setTime('')}>
              Bỏ giờ
            </button>
          </div>
        )}

        <label className="ev-toggle">
          <span className="ev-toggle__text">
            <span className="ev-toggle__label">Lặp lại hằng năm</span>
            <span className="field__hint">{yearly ? 'Mỗi năm đếm ngược lại tới ngày này' : 'Chỉ một lần'}</span>
          </span>
          <Switch
            checked={yearly}
            onChange={(on) => {
              setYearly(on);
              setRepeatTouched(true);
            }}
          />
        </label>

        <label className="field">
          <span className="field__label">Ghi chú (tuỳ chọn)</span>
          <textarea
            className="input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={MAX_EVENT_NOTE}
            rows={3}
            placeholder="Mang gì, đặt chỗ ở đâu…"
          />
          <span className="char-count">
            {note.length}/{MAX_EVENT_NOTE}
          </span>
        </label>

        <label className="ev-toggle">
          <span className="ev-toggle__text">
            <span className="ev-toggle__label">Nhắc trước</span>
            <span className="field__hint">Báo lên điện thoại trước 7 ngày, 1 ngày và vào ngày đó</span>
          </span>
          <Switch checked={remind} onChange={setRemind} />
        </label>

        <FormError error={save.error} />
        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={!valid || save.isPending}>
          {save.isPending ? <span className="spinner" aria-hidden="true" /> : null}
          {editing ? 'Lưu thay đổi' : 'Thêm sự kiện'}
        </button>
        </fieldset>
      </form>
    </BottomSheet>
  );
}

interface DetailProps {
  event: CoupleEvent | null;
  onClose: () => void;
  onEdit: (ev: CoupleEvent) => void;
  onDelete: (ev: CoupleEvent) => void;
  /** CP2: open the letter composer with this open date. */
  onWriteLetter?: (openOn: string) => void;
}

/**
 * Open date for "Viết thư mở vào ngày này": the event's next date, or next year's for a yearly event that is today
 * (a letter cannot open today). null when no letter can open on it (past one-off event, more than 20 years ahead).
 */
function letterDateFor(ev: CoupleEvent, today: string): string | null {
  const day = ev.nextDate > today ? ev.nextDate : ev.repeat === 'yearly' ? nextYearlyAfter(ev.date, today) : null;
  return day && inOpenRange(day, today) ? day : null;
}

/** One event: when, how long until, note; add to the phone calendar; edit and delete (not for auto milestones). */
export function EventDetailSheet({ event, onClose, onEdit, onDelete, onWriteLetter }: DetailProps) {
  const toast = useToast();
  const { me } = useAuth();
  const { nameOf } = usePeople();
  const { today } = useCouplePeople();
  const live = event !== null && event.kind === 'meet' && event.startsAt !== null && event.daysLeft >= 0;
  const now = useNow(1000, live);
  const msLeft = live ? new Date(event.startsAt!).getTime() - now : 0;
  const letterDay = event && onWriteLetter ? letterDateFor(event, today) : null;

  function addToCalendar(ev: CoupleEvent) {
    downloadIcs(ev, me?.couple?.id ?? '');
    toast.success('Đã tạo file lịch. Mở file để thêm vào lịch điện thoại.');
  }

  const info = event ? kindInfo(event.kind) : null;

  return (
    <BottomSheet open={event !== null} onClose={onClose} title={event?.auto ? 'Mốc tự động' : (info?.label ?? 'Sự kiện')}>
      {event && (
        <div className="stack">
          <div className="ev-detail">
            <span className="ev-detail__emoji" aria-hidden="true">
              {event.emoji}
            </span>
            <p className="ev-detail__title">{event.title}</p>
            <p className="text-muted">
              {eventDayText(event.nextDate)}
              {event.time ? ` · ${event.time}` : ''}
            </p>
            <span className={`chip ${event.daysLeft < 0 ? '' : 'chip--brand'}`}>{capitalize(daysLeftText(event.daysLeft))}</span>
            {live && msLeft > 0 && <CountdownCells ms={msLeft} />}
          </div>

          {(event.personId || (event.repeat === 'yearly' && !event.auto)) && (
            <p className="text-sm text-muted center">
              {event.personId ? `Sinh nhật của ${nameOf(event.personId)}` : ''}
              {event.personId && event.repeat === 'yearly' ? ' · ' : ''}
              {event.repeat === 'yearly' && !event.auto ? `Hằng năm, từ ${formatDay(event.date)}` : ''}
            </p>
          )}
          {event.note && <p className="ev-detail__note">{event.note}</p>}
          {event.auto && (
            <p className="callout">
              <Icon name="heart" size={18} />
              <span>Mốc này tự tính từ ngày bắt đầu yêu ở Hồ sơ, nên không sửa hay xóa được.</span>
            </p>
          )}

          <div className="list">
            <button type="button" className="list__item" onClick={() => addToCalendar(event)}>
              <span className="icon-tile icon-tile--neutral" aria-hidden="true">
                <Icon name="calendar" size={20} />
              </span>
              <span className="list__body">
                <span className="list__label">Thêm vào lịch điện thoại</span>
              </span>
            </button>
            {letterDay && onWriteLetter && (
              <button type="button" className="list__item" onClick={() => onWriteLetter(letterDay)}>
                <span className="icon-tile icon-tile--neutral" aria-hidden="true">
                  <Icon name="mail" size={20} />
                </span>
                <span className="list__body">
                  <span className="list__label">Viết thư mở vào ngày này</span>
                  <span className="list__meta" style={{ display: 'block' }}>
                    Mở vào {formatDay(letterDay)}
                  </span>
                </span>
              </button>
            )}
            {!event.auto && (
              <>
                <button type="button" className="list__item" onClick={() => onEdit(event)}>
                  <span className="icon-tile icon-tile--neutral" aria-hidden="true">
                    <Icon name="edit" size={20} />
                  </span>
                  <span className="list__body">
                    <span className="list__label">Sửa sự kiện</span>
                  </span>
                </button>
                <button type="button" className="list__item" onClick={() => onDelete(event)}>
                  <span className="icon-tile icon-tile--neutral" aria-hidden="true">
                    <Icon name="trash" size={20} />
                  </span>
                  <span className="list__body">
                    <span className="list__label text-danger">Xóa sự kiện</span>
                  </span>
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </BottomSheet>
  );
}

/** Confirm before the soft delete; either member may delete. */
export function DeleteEventSheet({ event, onClose }: { event: CoupleEvent | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { partnerName } = usePeople();
  const remove = useMutation({
    mutationFn: (id: string) => eventsApi.remove(id),
    onSuccess: async () => {
      toast.info('Đã xóa sự kiện');
      onClose();
      await refreshEvents(qc);
    },
    onError: (err) => toast.error(err instanceof ApiRequestError ? err.message : 'Không xóa được, thử lại nhé.'),
  });

  useEffect(() => { remove.reset(); }, [event?.id]);

  return (
    <BottomSheet open={event !== null} busy={remove.isPending} onClose={onClose} title="Xóa sự kiện?">
      {event && (
        <div className="stack">
          <p className="text-muted">
            “{event.title}” sẽ không còn hiện với cả bạn và {partnerName}.
          </p>
          <FormError error={remove.error} />
          <div className="btn-row">
            <button type="button" className="btn btn-secondary" disabled={remove.isPending} onClick={onClose}>
              Hủy
            </button>
            <button type="button" className="btn btn-danger" disabled={remove.isPending} onClick={() => remove.mutate(event.id)}>
              Xóa
            </button>
          </div>
        </div>
      )}
    </BottomSheet>
  );
}
