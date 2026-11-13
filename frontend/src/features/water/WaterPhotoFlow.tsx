import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BottomSheet } from '../../components/BottomSheet';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { useAuth } from '../auth/AuthContext';
import { ApiRequestError } from '../../lib/apiClient';
import { formatMl, shortName } from '../../lib/format';
import type { WaterSubmitResult } from '../../lib/types';
import { pushSuggest } from '../push/suggest';
import { WATER_KEY, WATER_PENDING_KEY, uploadAndAnalyze, type PhotoStage } from './api';

const STAGES: PhotoStage[] = ['compress', 'upload', 'analyze'];
const STAGE_LABEL: Record<PhotoStage, string> = {
  compress: 'Đang chuẩn bị ảnh…',
  upload: 'Đang tải ảnh lên…',
  analyze: 'AI đang ước lượng lượng nước…',
};

type FlowState =
  | { kind: 'idle' }
  | { kind: 'working'; stage: PhotoStage }
  | { kind: 'done'; result: WaterSubmitResult }
  | { kind: 'error'; message: string; manualFallback: boolean };

interface Props {
  label?: string;
  className?: string;
  /** Called when the user picks "Nhập thủ công" after an AI failure. */
  onManual: () => void;
}

/**
 * Camera button + guided sheet: photo preview → (compress, upload, AI) steps → result
 * "sent to partner for approval", or a friendly error with retry / manual entry.
 */
export function WaterPhotoFlow({ label = 'Chụp ảnh ly nước', className = 'btn btn-water btn-lg btn-block', onManual }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const partner = me?.couple?.members.find((m) => m.id !== me.user.id);
  const partnerName = partner ? shortName(partner.displayName) : 'người ấy';

  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [state, setState] = useState<FlowState>({ kind: 'idle' });

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  // Release the object URL when the preview changes or the component unmounts.
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  function pick() {
    inputRef.current?.click();
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Chỉ chấp nhận ảnh.');
      return;
    }
    setPreview(URL.createObjectURL(file));
    setOpen(true);
    setState({ kind: 'working', stage: 'compress' });
    try {
      const result = await uploadAndAnalyze(file, (stage) => setState({ kind: 'working', stage }));
      setState({ kind: 'done', result });
      pushSuggest.trigger('couple');
      await Promise.all([
        qc.invalidateQueries({ queryKey: WATER_KEY }),
        qc.invalidateQueries({ queryKey: WATER_PENDING_KEY }),
      ]);
      if (!openRef.current) toast.success(`Đã gửi ${formatMl(result.amountMl)} cho ${partnerName} xác nhận`);
    } catch (err) {
      const manualFallback =
        err instanceof ApiRequestError && Boolean((err.details as { manualFallback?: boolean } | undefined)?.manualFallback);
      const message = err instanceof Error ? err.message : 'Có lỗi xảy ra, thử lại nhé.';
      setState({ kind: 'error', message, manualFallback });
      if (!openRef.current) toast.error(message);
    }
  }

  function close() {
    setOpen(false);
    if (state.kind !== 'working') setState({ kind: 'idle' });
  }

  const stageIndex = state.kind === 'working' ? STAGES.indexOf(state.stage) : state.kind === 'done' ? STAGES.length : -1;

  return (
    <>
      <input ref={inputRef} type="file" accept="image/*" capture="environment" hidden onChange={onFile} />
      <button type="button" className={className} onClick={pick} disabled={state.kind === 'working'}>
        {state.kind === 'working' ? <span className="spinner" aria-hidden="true" /> : <Icon name="camera" size={20} />}
        {state.kind === 'working' ? 'Đang xử lý…' : label}
      </button>

      <BottomSheet open={open} onClose={close} title="Ghi nhận nước bằng ảnh">
        <div className="stack">
          {preview && <img className="photo-flow__preview" src={preview} alt="Ảnh vừa chọn" />}

          {state.kind === 'working' && (
            <div className="photo-flow__status" role="status" aria-live="polite">
              <div className="stepper" aria-hidden="true">
                {STAGES.map((s, i) => (
                  <span key={s} className={`stepper__dot${i <= stageIndex ? ' is-done' : ''}`} />
                ))}
              </div>
              <p className="strong">{STAGE_LABEL[state.stage]}</p>
              <p className="text-sm text-muted">Thường mất vài giây.</p>
            </div>
          )}

          {state.kind === 'done' && (
            <div className="photo-flow__status">
              <span className="chip chip--water">AI ước lượng</span>
              <p className="photo-flow__result">{formatMl(state.result.amountMl)}</p>
              <p className="text-muted">
                Đã gửi ảnh cho <strong>{partnerName}</strong> xác nhận. Lượng nước sẽ được cộng khi {partnerName} đồng ý.
              </p>
              <button type="button" className="btn btn-primary btn-block btn-lg" onClick={close}>
                Xong
              </button>
            </div>
          )}

          {state.kind === 'error' && (
            <div className="photo-flow__status" role="alert">
              <span className="icon-tile icon-tile--warning" aria-hidden="true">
                <Icon name="alert" />
              </span>
              <p className="strong">{state.message}</p>
              <div className="btn-row" style={{ width: '100%' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    close();
                    onManual();
                  }}
                >
                  Nhập thủ công
                </button>
                <button type="button" className="btn btn-water" onClick={pick}>
                  <Icon name="camera" size={18} /> Chụp lại
                </button>
              </div>
            </div>
          )}
        </div>
      </BottomSheet>
    </>
  );
}
