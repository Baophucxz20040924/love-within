import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BottomSheet } from '../../components/BottomSheet';
import { FormError, useFormDismiss } from '../../components/useFormDismiss';
import { useToast } from '../../components/Toast';
import { ApiRequestError } from '../../lib/apiClient';
import type { DailyQuestion, TodayQuestion } from '../../lib/types';
import { PULSE_KEY } from '../couple/api';
import { MAX_ANSWER, MAX_ASK, QUESTION_TODAY_KEY, QUESTIONS_KEY, applyQuestion, questionsApi } from './api';
import { questionLabel, useCouplePeople } from './useCouplePeople';

interface AnswerSheetProps {
  open: boolean;
  question: DailyQuestion | null;
  onClose: () => void;
  /** Called with the saved view (e.g. to open the answers once both answered). */
  onSaved?: (q: DailyQuestion) => void;
}

/** Answer (or edit my answer to) one day's question. Editable until the partner answers too. */
export function AnswerSheet({ open, question, onClose, onSaved }: AnswerSheetProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const { myId, partnerName, today } = useCouplePeople();
  const [body, setBody] = useState('');
  const [attempted, setAttempted] = useState(false);
  useEffect(() => { if (open) setAttempted(false); }, [open]);
  const editing = Boolean(question?.mine);

  useEffect(() => {
    if (open) setBody(question?.mine?.body ?? '');
  }, [open, question?.id, question?.mine?.body]);

  const save = useMutation({
    mutationFn: (text: string) => questionsApi.answer(question!.id, text),
    onSuccess: async (q) => {
      toast.success(editing ? 'Đã lưu câu trả lời' : q.locked ? `Đã gửi! Giờ bạn xem được câu của ${partnerName} rồi` : 'Đã gửi câu trả lời');
      onClose();
      onSaved?.(q);
      await applyQuestion(qc, q);
    },
    onError: async (err) => {
      toast.error(err instanceof ApiRequestError ? err.message : 'Có lỗi xảy ra, thử lại nhé.');
      if (err instanceof ApiRequestError && err.code === 'QUESTION_LOCKED') {
        await Promise.all([qc.invalidateQueries({ queryKey: QUESTIONS_KEY }), qc.invalidateQueries({ queryKey: PULSE_KEY })]);
      }
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setAttempted(true);
    if (!body.trim() || unchanged || save.isPending || locked) return;
    save.mutate(body.trim());
  }

  const text = body.trim();
  const unchanged = editing && text === question?.mine?.body;
  const label = question ? questionLabel(question, myId, partnerName) : null;
  const hint = !question
    ? ''
    : editing
      ? `Bạn sửa được tới khi ${partnerName} trả lời.`
      : question.partner.answered
        ? `${partnerName} đã trả lời. Gửi xong bạn sẽ thấy câu của ${partnerName}, và hai câu sẽ không sửa được nữa.`
        : `${partnerName} chỉ thấy câu trả lời của bạn khi cũng đã trả lời. Trước lúc đó bạn vẫn sửa được.`;
  const late = question !== null && !editing && question.localDate < today;
  const locked = question?.locked || (save.error instanceof ApiRequestError && save.error.code === 'QUESTION_LOCKED');
  const { requestClose, discardPrompt } = useFormDismiss({ open, dirty: body !== (question?.mine?.body ?? ''), busy: save.isPending, onClose });

  return (
    <BottomSheet open={open} busy={save.isPending} onClose={requestClose} title={editing ? 'Sửa câu trả lời' : 'Trả lời câu hỏi'}>
      {discardPrompt}
      {question && (
        <form className="form" onSubmit={onSubmit} noValidate>
          <fieldset className="form-fields" disabled={save.isPending}>
          <div className="q-quote">
            {label && <p className="q-quote__label">{label}</p>}
            <p className="q-quote__text">{question.text}</p>
          </div>
          <label className="field">
            <span className="field__label">Câu trả lời của bạn</span>
            <textarea
              className="input q-input"
              aria-invalid={attempted && !text}
              aria-describedby={attempted && !text ? 'answer-error' : undefined}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={MAX_ANSWER}
              rows={5}
              placeholder="Viết thật lòng nhé…"
            />
            <span className="char-count">
              {body.length}/{MAX_ANSWER}
            </span>
          </label>
          {attempted && !text && <p id="answer-error" className="field__hint text-danger">Viết câu trả lời trước khi gửi nhé.</p>}
          <p className="field__hint">
            {hint}
            {late && ' Trả lời bù vẫn được, chỉ không có thưởng Xu.'}
          </p>
          <FormError error={save.error} />
          {locked && <p className="field__hint">Câu hỏi đã khóa. Bạn có thể sao chép nội dung trước khi đóng.</p>}
          <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={unchanged || save.isPending || locked}>
            {save.isPending ? <span className="spinner" aria-hidden="true" /> : null}
            {save.isPending ? 'Đang gửi…' : editing ? 'Lưu thay đổi' : 'Gửi'}
          </button>
          </fieldset>
        </form>
      )}
    </BottomSheet>
  );
}

/** "Hỏi người ấy": write my own question; it becomes a later day's question for both of us. */
export function AskSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { partnerName } = useCouplePeople();
  const [text, setText] = useState('');
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    if (open) { setText(''); setAttempted(false); }
  }, [open]);

  const send = useMutation({
    mutationFn: (value: string) => questionsApi.ask(value),
    onSuccess: (ask) => {
      toast.success(`Đã gửi. Ngày mai ${partnerName} sẽ thấy câu hỏi của bạn 💌`);
      qc.setQueryData<TodayQuestion>(QUESTION_TODAY_KEY, (old) => (old ? { ...old, myAsk: ask } : old));
      onClose();
    },
    onError: async (err) => {
      toast.error(err instanceof ApiRequestError ? err.message : 'Có lỗi xảy ra, thử lại nhé.');
      if (err instanceof ApiRequestError && err.code === 'ASK_ALREADY_SENT') {
        await qc.invalidateQueries({ queryKey: QUESTION_TODAY_KEY });
      }
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setAttempted(true);
    if (!text.trim() || send.isPending || alreadySent) return;
    send.mutate(text.trim());
  }

  const alreadySent = send.error instanceof ApiRequestError && send.error.code === 'ASK_ALREADY_SENT';
  const { requestClose, discardPrompt } = useFormDismiss({ open, dirty: text !== '', busy: send.isPending, onClose });

  return (
    <BottomSheet open={open} busy={send.isPending} onClose={requestClose} title={`Hỏi ${partnerName}`}>
      {discardPrompt}
      <form className="form" onSubmit={onSubmit} noValidate>
        <fieldset className="form-fields" disabled={send.isPending}>
        <p className="text-sm text-muted">
          Câu này sẽ là câu hỏi của ngày mai cho cả hai bạn. Mỗi ngày bạn gửi được một câu. Nếu {partnerName} cũng vừa gửi một câu trước bạn,
          câu của bạn sẽ dời sang ngày sau.
        </p>
        <label className="field">
          <span className="field__label">Câu hỏi của bạn</span>
          <textarea
            className="input"
            value={text}
            aria-invalid={attempted && !text.trim()}
            aria-describedby={attempted && !text.trim() ? 'ask-error' : undefined}
            onChange={(e) => setText(e.target.value)}
            maxLength={MAX_ASK}
            rows={3}
            placeholder="VD: Món ăn nào làm bạn nhớ nhà nhất?"
          />
          <span className="char-count">
            {text.length}/{MAX_ASK}
          </span>
        </label>
        {attempted && !text.trim() && <p id="ask-error" className="field__hint text-danger">Viết câu hỏi trước khi gửi nhé.</p>}
        <FormError error={send.error} />
        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={send.isPending || alreadySent}>
          {send.isPending ? 'Đang gửi…' : 'Gửi câu hỏi'}
        </button>
        </fieldset>
      </form>
    </BottomSheet>
  );
}
