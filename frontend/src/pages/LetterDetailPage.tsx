import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BottomSheet } from '../components/BottomSheet';
import { GalleryViewer } from '../components/GalleryViewer';
import { Icon } from '../components/Icon';
import { ErrorState, Page, Skeleton } from '../components/StatusViews';
import { useToast } from '../components/Toast';
import { PULSE_KEY } from '../features/couple/api';
import { LETTER_LIST_KEY, MAX_LETTER_TITLE, letterKey, lettersApi, refreshLetters } from '../features/letters/api';
import { ENVELOPE_OPEN_MS, Envelope, prefersReducedMotion } from '../features/letters/Envelope';
import { openedWhen, sealedLeft, sealedLine } from '../features/letters/labels';
import { LetterComposer } from '../features/letters/LetterComposer';
import { PhotoGrid } from '../features/stories/PhotoGrid';
import { ApiRequestError } from '../lib/apiClient';
import { formatDate, formatDay, shortName } from '../lib/format';
import type { LetterSummary, LetterView } from '../lib/types';

/** Before the open time: the envelope only (the server sent no title, body or photo). */
function SealedView({ l }: { l: LetterSummary }) {
  const from = shortName(l.from.displayName);
  return (
    <section className="card letter-env" aria-label="Phong bì đang niêm phong">
      <Envelope state="sealed" />
      <p className="letter-env__line">{sealedLine(from, l.openOn, l.daysLeft)}</p>
      <p className="callout">
        <Icon name="lock" size={18} />
        <span>Thư được niêm phong tới 00:00 ngày {formatDay(l.openOn)}. Tới ngày đó bạn sẽ mở được.</span>
      </p>
    </section>
  );
}

/** The day has come but the letter is still closed: "Mở thư" plays the envelope animation, then shows the letter. */
function ReadyView({ l, opening, onOpen }: { l: LetterSummary; opening: boolean; onOpen: () => void }) {
  const from = shortName(l.from.displayName);
  return (
    <section className="card letter-env" aria-label="Phong bì">
      <Envelope state={opening ? 'opening' : 'ready'} />
      <p className="letter-env__line">
        Thư từ {from} · mở được từ {l.daysLeft === 0 ? 'hôm nay' : formatDay(l.openOn)}
      </p>
      <button type="button" className="btn btn-primary btn-lg btn-block" disabled={opening} onClick={onOpen}>
        {opening ? <span className="spinner" aria-hidden="true" /> : <Icon name="mail" size={20} />}
        {opening ? 'Đang mở…' : 'Mở thư'}
      </button>
    </section>
  );
}

function LetterPaper({ l, revealed, onPhoto }: { l: LetterView; revealed: boolean; onPhoto: (i: number) => void }) {
  const c = l.content!;
  const from = shortName(l.from.displayName);
  const to = shortName(l.to.displayName);
  return (
    <article className={`letter-paper${revealed ? ' letter-paper--reveal' : ''}`} aria-label={c.title || 'Lá thư'}>
      <p className="letter-paper__meta">
        {l.isMine ? `Gửi ${to}` : `Từ ${from}`} · viết ngày {formatDate(l.createdAt)}
        {l.editedAt ? ' · đã sửa' : ''}
      </p>
      {c.title && <h2 className="letter-paper__title">{c.title}</h2>}
      <p className="letter-paper__body">{c.body}</p>
      <PhotoGrid photos={c.photos} onOpen={onPhoto} />
      <p className="letter-paper__sign">{from}</p>
    </article>
  );
}

/** /letters/:id — one letter: sealed envelope, "Mở thư", or the letter itself (always for its author). */
export function LetterDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [composer, setComposer] = useState<{ open: boolean; editing: LetterView | null; title: string }>({ open: false, editing: null, title: '' });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [gallery, setGallery] = useState<number | null>(null);
  const [opening, setOpening] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const query = useQuery({
    queryKey: letterKey(id),
    queryFn: () => lettersApi.get(id),
    staleTime: 0,
    refetchOnWindowFocus: true,
    retry: (count, err) => !(err instanceof ApiRequestError && [400, 403, 404].includes(err.status)) && count < 1,
  });
  const err = query.error instanceof ApiRequestError ? query.error : null;
  const sealed = err?.code === 'LETTER_SEALED' ? ((err.details as { letter?: LetterSummary } | undefined)?.letter ?? null) : null;
  const notFound = err !== null && (err.status === 404 || err.status === 400);
  const letter = query.isError ? undefined : query.data;
  const head = letter ?? sealed;

  const remove = useMutation({
    mutationFn: () => lettersApi.remove(id),
    onSuccess: async () => {
      setConfirmDelete(false);
      toast.info('Đã xóa thư');
      qc.removeQueries({ queryKey: letterKey(id) });
      navigate('/letters', { replace: true });
      await refreshLetters(qc);
    },
    onError: (e) => toast.error(e instanceof ApiRequestError ? e.message : 'Không xóa được, thử lại nhé.'),
  });

  // Opened from the list or Home: go back there; a direct link falls back to the list.
  const goBack = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate('/letters', { replace: true });
  };

  async function openLetter() {
    if (opening) return;
    setOpening(true);
    const wait = prefersReducedMotion() ? 0 : ENVELOPE_OPEN_MS;
    try {
      const [view] = await Promise.all([lettersApi.open(id), new Promise((r) => window.setTimeout(r, wait))]);
      qc.setQueryData(letterKey(id), view);
      setRevealed(true);
      void qc.invalidateQueries({ queryKey: LETTER_LIST_KEY });
      void qc.invalidateQueries({ queryKey: PULSE_KEY });
    } catch (e) {
      toast.error(e instanceof ApiRequestError ? e.message : 'Không mở được thư, thử lại nhé.');
      void query.refetch();
    } finally {
      setOpening(false);
    }
  }

  const title = head ? (head.isMine ? `Thư gửi ${shortName(head.to.displayName)}` : `Thư từ ${shortName(head.from.displayName)}`) : 'Thư hẹn giờ';
  const to = letter ? shortName(letter.to.displayName) : '';

  return (
    <Page title={title} subtitle={head ? `Mở vào ${formatDay(head.openOn)}` : undefined} onBack={goBack}>
      {query.isLoading && <Skeleton height={320} />}
      {sealed && <SealedView l={sealed} />}
      {notFound && <ErrorState title="Không tìm thấy thư" message="Thư này không tồn tại hoặc đã bị xóa." />}
      {query.isError && !sealed && !notFound && <ErrorState onRetry={() => void query.refetch()} />}

      {letter && !letter.content && <ReadyView l={letter} opening={opening} onOpen={() => void openLetter()} />}

      {letter?.content && (
        <>
          {letter.isMine && (
            <p className={`letter-status${letter.openedAt ? ' letter-status--opened' : ''}`} role="status">
              <Icon name={letter.openedAt ? 'check' : letter.openable ? 'clock' : 'lock'} size={18} />
              <span>
                {letter.openedAt
                  ? `${to} đã mở lúc ${openedWhen(letter.openedAt)}`
                  : letter.openable
                    ? `Đã tới ngày mở. ${to} chưa mở thư.`
                    : `${to} mở được từ ${formatDay(letter.openOn)} · ${sealedLeft(letter.daysLeft)}`}
              </span>
            </p>
          )}

          <LetterPaper l={letter} revealed={revealed} onPhoto={setGallery} />

          {letter.isMine && !letter.openedAt && (
            <div className="list">
              <button type="button" className="list__item" onClick={() => setComposer({ open: true, editing: letter, title: '' })}>
                <span className="icon-tile icon-tile--neutral" aria-hidden="true">
                  <Icon name="edit" size={20} />
                </span>
                <span className="list__body">
                  <span className="list__label">Sửa thư</span>
                  <span className="list__meta" style={{ display: 'block' }}>
                    Sửa được tới khi {to} mở thư
                  </span>
                </span>
              </button>
              <button type="button" className="list__item" onClick={() => setConfirmDelete(true)}>
                <span className="icon-tile icon-tile--neutral" aria-hidden="true">
                  <Icon name="trash" size={20} />
                </span>
                <span className="list__body">
                  <span className="list__label text-danger">Xóa thư</span>
                </span>
              </button>
            </div>
          )}
          {letter.isMine && letter.openedAt && (
            <p className="field__hint center">Thư đã được mở nên không sửa hay xóa được nữa.</p>
          )}

          {!letter.isMine && (
            <>
              {letter.openedAt && <p className="field__hint center">Bạn mở thư lúc {openedWhen(letter.openedAt)}</p>}
              <button
                type="button"
                className="btn btn-primary btn-lg btn-block"
                onClick={() => {
                  const t = letter.content?.title;
                  setComposer({ open: true, editing: null, title: t ? `Trả lời: ${t}`.slice(0, MAX_LETTER_TITLE) : '' });
                }}
              >
                <Icon name="send" size={20} /> Viết thư trả lời
              </button>
            </>
          )}

          <GalleryViewer urls={letter.content.photos.map((p) => p.url)} index={gallery} onClose={() => setGallery(null)} />
        </>
      )}

      <LetterComposer
        open={composer.open}
        editing={composer.editing}
        initialTitle={composer.title}
        onClose={() => setComposer({ open: false, editing: null, title: '' })}
        onSaved={(saved) => {
          if (saved.id !== id) navigate(`/letters/${saved.id}`);
        }}
      />

      <BottomSheet open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Xóa thư?">
        <div className="stack">
          <p className="text-muted">{to ? `${to} sẽ không còn thấy phong bì này.` : 'Phong bì sẽ không còn hiện nữa.'}</p>
          <div className="btn-row">
            <button type="button" className="btn btn-secondary" onClick={() => setConfirmDelete(false)}>
              Hủy
            </button>
            <button type="button" className="btn btn-danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
              Xóa
            </button>
          </div>
        </div>
      </BottomSheet>
    </Page>
  );
}
