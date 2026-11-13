import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Avatar } from '../components/Avatar';
import { BottomSheet } from '../components/BottomSheet';
import { Icon } from '../components/Icon';
import { ErrorState, Page, Skeleton } from '../components/StatusViews';
import { useToast } from '../components/Toast';
import { FRIEND_EVENTS_KEY, friendEventKey, friendEventsApi } from '../features/friends/api';
import { countsLabel, downloadEventIcs, mapHref, RSVP_LABEL, statusLabel, whenLabel } from '../features/friends/eventFormat';
import { eventCommentApi, FriendComments } from '../features/friends/FriendComments';
import { FriendComposer } from '../features/friends/FriendComposer';
import { FriendEventSheet } from '../features/friends/FriendEventSheet';
import { EventOutingEntry } from '../features/friends/outings/EventOutingEntry';
import { BlockSheet, ReportSheet, type ReportTargetInfo } from '../features/friends/SafetySheets';
import { useGoBack } from '../features/friends/useGoBack';
import { ApiRequestError } from '../lib/apiClient';
import type { FriendEventDetail, FriendEventGuest, RsvpStatus } from '../lib/types';

const errorText = (err: unknown) => (err instanceof ApiRequestError ? err.message : 'Có lỗi xảy ra, thử lại nhé.');
const RSVPS: RsvpStatus[] = ['going', 'maybe', 'declined'];
const GROUPS: { key: keyof FriendEventDetail['guests']; label: string }[] = [
  { key: 'going', label: 'Đi' },
  { key: 'maybe', label: 'Có thể' },
  { key: 'pending', label: 'Chưa trả lời' },
  { key: 'declined', label: 'Không đi' },
];

function GuestGroup({ label, people }: { label: string; people: FriendEventGuest[] }) {
  if (people.length === 0) return null;
  return (
    <div className="fev-guests__group">
      <h3 className="fev-guests__title">
        {label} <span className="text-muted">{people.length}</span>
      </h3>
      <ul className="fev-guests__list">
        {people.map((p) => (
          <li key={p.id}>
            <Link to={`/friends/u/${p.id}`} className="fev-guest">
              <Avatar name={p.displayName} src={p.avatarUrl} size={36} />
              <span className="fev-guest__name">{p.displayName}</span>
              {p.isCreator && <span className="chip chip--brand">Người tạo</span>}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** /friends/events/:id — one event: info, Đi · Có thể · Không đi, guests by answer, discussion, calendar and map. */
export function FriendEventPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const goBack = useGoBack('/friends/events');
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<'cancel' | 'delete' | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const confirming = useRef(false);
  function openConfirm(action: 'cancel' | 'delete') {
    if (confirming.current) return;
    setConfirmError(null);
    setConfirm(action);
  }
  function closeConfirm() {
    if (!confirming.current) setConfirm(null);
  }
  const [posting, setPosting] = useState(false);
  const [reporting, setReporting] = useState<ReportTargetInfo | null>(null);
  const [blocking, setBlocking] = useState<{ id: string; displayName: string } | null>(null);
  const commentApi = useMemo(() => eventCommentApi(id), [id]);

  const key = friendEventKey(id);
  const event = useQuery({
    queryKey: key,
    queryFn: () => friendEventsApi.get(id),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    retry: (count, err) => !(err instanceof ApiRequestError && err.status === 404) && count < 1,
  });
  const notFound = event.error instanceof ApiRequestError && event.error.status === 404;
  const ev = event.data;

  const saved = (next: FriendEventDetail) => {
    qc.setQueryData(key, next);
    void qc.invalidateQueries({ queryKey: FRIEND_EVENTS_KEY });
  };

  const rsvp = useMutation({
    mutationFn: (status: RsvpStatus) => friendEventsApi.rsvp(id, status),
    onMutate: (status) => qc.setQueryData<FriendEventDetail>(key, (e) => (e ? { ...e, myRsvp: status } : e)),
    onSuccess: (next, status) => {
      saved(next);
      toast.success(status === 'going' ? 'Bạn sẽ đi kèo này' : status === 'maybe' ? 'Bạn có thể đi' : 'Bạn sẽ không đi');
    },
    onError: (err) => {
      toast.error(errorText(err));
      void event.refetch();
    },
  });
  const cancel = useMutation({
    mutationFn: () => friendEventsApi.cancel(id),
    onSuccess: (next) => {
      setConfirm(null);
      saved(next);
      toast.info('Đã hủy kèo. Mọi người được mời đã được báo.');
    },
    onError: (err) => setConfirmError(errorText(err)),
    onSettled: () => { confirming.current = false; },
  });
  const remove = useMutation({
    mutationFn: () => friendEventsApi.remove(id),
    onSuccess: () => {
      setConfirm(null);
      qc.removeQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: FRIEND_EVENTS_KEY });
      toast.info('Đã xóa kèo');
      navigate('/friends/events', { replace: true });
    },
    onError: (err) => setConfirmError(errorText(err)),
    onSettled: () => { confirming.current = false; },
  });

  const open = ev && ev.status === 'active' && !ev.past;
  const map = ev ? mapHref(ev) : null;

  return (
    <Page title="Kèo" onBack={goBack}>
      {event.isLoading && <Skeleton height={320} />}
      {event.isError &&
        (notFound ? (
          <ErrorState title="Kèo không còn nữa" message="Kèo đã bị xóa, hoặc bạn không còn xem được kèo này." />
        ) : (
          <ErrorState onRetry={() => void event.refetch()} />
        ))}
      {ev && !event.isError && (
        <>
          <article className="card fev-detail">
            {ev.cover && <img className="fev-detail__cover" src={ev.cover.url} alt="" />}
            <div className="fev-detail__chips">
              <span className={`chip${ev.status === 'cancelled' ? ' chip--danger' : ' chip--brand'}`}>{statusLabel(ev)}</span>
              {ev.editedAt && <span className="chip">Đã sửa</span>}
            </div>
            <h2 className="fev-detail__title">{ev.title}</h2>
            <p className="fev-detail__by">
              <Avatar name={ev.creator.displayName} src={ev.creator.avatarUrl} size={24} />
              <span>
                {ev.isMine ? 'Bạn' : <Link to={`/friends/u/${ev.creator.id}`}>{ev.creator.displayName}</Link>} tạo kèo này
              </span>
            </p>
            <p className="fev-detail__line">
              <Icon name="clock" size={18} />
              <span>{whenLabel(ev)}</span>
            </p>
            {ev.place && (
              <p className="fev-detail__line">
                <Icon name="mapPin" size={18} />
                <span>{ev.place}</span>
              </p>
            )}
            {ev.description && <p className="fev-detail__desc">{ev.description}</p>}

            {ev.status === 'cancelled' && (
              <p className="fev-detail__banner fev-detail__banner--danger" role="status">
                Kèo này đã bị hủy.
              </p>
            )}
            {ev.past && ev.status === 'active' && (
              <div className="fev-detail__banner">
                <p>Kèo đã qua. Có ảnh đẹp thì đăng cho mọi người xem nhé!</p>
                <button type="button" className="btn btn-primary btn-block" onClick={() => setPosting(true)}>
                  <Icon name="image" size={18} /> Đăng ảnh buổi này
                </button>
              </div>
            )}

            {open && !ev.isMine && (
              <div className="fev-rsvp" role="radiogroup" aria-label="Bạn có đi không?">
                {RSVPS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    role="radio"
                    aria-checked={ev.myRsvp === s}
                    className={`fev-rsvp__btn${ev.myRsvp === s ? ' is-active' : ''}`}
                    disabled={rsvp.isPending}
                    onClick={() => ev.myRsvp !== s && rsvp.mutate(s)}
                  >
                    {s === 'going' && <Icon name="check" size={18} />}
                    {RSVP_LABEL[s]}
                  </button>
                ))}
              </div>
            )}
            {open && !ev.isMine && !ev.myRsvp && <p className="field__hint">Bạn chưa trả lời. Người tạo kèo sẽ biết nếu bạn chọn Đi.</p>}

            <div className="fev-detail__actions">
              {ev.status === 'active' && (
                <button type="button" className="btn btn-outline" onClick={() => downloadEventIcs(ev)}>
                  <Icon name="calendarPlus" size={18} /> Thêm vào lịch
                </button>
              )}
              {map && (
                <a className="btn btn-outline" href={map} target="_blank" rel="noopener noreferrer">
                  <Icon name="mapPin" size={18} /> Mở bản đồ
                </a>
              )}
            </div>

            {ev.isMine && (
              <div className="fev-detail__owner">
                {open && (
                  <>
                    <button type="button" className="btn btn-secondary" onClick={() => setEditing(true)}>
                      <Icon name="edit" size={18} /> Sửa · Mời thêm
                    </button>
                    <button type="button" className="btn btn-ghost text-danger" disabled={cancel.isPending || remove.isPending} onClick={() => openConfirm('cancel')}>
                      Hủy kèo
                    </button>
                  </>
                )}
                {!open && (
                  <button type="button" className="btn btn-ghost text-danger" disabled={cancel.isPending || remove.isPending} onClick={() => openConfirm('delete')}>
                    <Icon name="trash" size={18} /> Xóa kèo
                  </button>
                )}
              </div>
            )}
            {!ev.isMine && (
              <button
                type="button"
                className="btn btn-ghost fev-detail__report"
                onClick={() => setReporting({ type: 'event', id: ev.id, owner: ev.creator })}
              >
                Báo cáo kèo
              </button>
            )}
          </article>

          <section className="card fev-guests" aria-labelledby="fev-guests-title">
            <h2 id="fev-guests-title" className="card__title">
              Khách mời
            </h2>
            <p className="fev-guests__summary">{countsLabel(ev.counts)}</p>
            {GROUPS.map((g) => (
              <GuestGroup key={g.key} label={g.label} people={ev.guests[g.key]} />
            ))}
          </section>

          <EventOutingEntry event={ev} />

          <section className="fev-discussion" aria-labelledby="fev-discussion-title">
            <h2 id="fev-discussion-title" className="section__title">
              Thảo luận
            </h2>
            <FriendComments api={commentApi} focusKey={0} />
          </section>

          <FriendEventSheet open={editing} editing={ev} onClose={() => setEditing(false)} onSaved={saved} />
          <FriendComposer open={posting} editing={null} initialBody={`${ev.title}\n`} onClose={() => setPosting(false)} />
          <BottomSheet open={confirm !== null} onClose={closeConfirm} busy={cancel.isPending || remove.isPending} title={confirm === 'cancel' ? 'Hủy kèo này?' : 'Xóa kèo này?'}>
            <div className="stack">
              <p className="text-muted">
                {confirm === 'cancel'
                  ? 'Mọi người được mời sẽ nhận thông báo kèo đã bị hủy. Kèo vẫn hiện với chữ "Đã hủy" cho tới khi bạn xóa.'
                  : 'Kèo, danh sách khách mời và thảo luận sẽ không còn hiển thị với ai.'}
              </p>
              {confirmError && <p id="event-confirm-error" className="form-error" role="alert">{confirmError}</p>}
              <div className="btn-row">
                <button type="button" className="btn btn-secondary" disabled={cancel.isPending || remove.isPending} onClick={closeConfirm}>
                  Không
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={cancel.isPending || remove.isPending}
                  aria-describedby={confirmError ? 'event-confirm-error' : undefined}
                  onClick={() => {
                    if (!confirm || confirming.current) return;
                    confirming.current = true;
                    setConfirmError(null);
                    if (confirm === 'cancel') cancel.mutate();
                    else remove.mutate();
                  }}
                >
                  {confirm === 'cancel' ? 'Hủy kèo' : 'Xóa kèo'}
                </button>
              </div>
            </div>
          </BottomSheet>
          <ReportSheet target={reporting} onClose={() => setReporting(null)} onBlock={setBlocking} />
          <BlockSheet user={blocking} onClose={() => setBlocking(null)} onBlocked={() => navigate('/friends/events', { replace: true })} />
        </>
      )}
    </Page>
  );
}
