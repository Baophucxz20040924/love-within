import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BottomSheet } from '../../components/BottomSheet';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { ApiRequestError } from '../../lib/apiClient';
import { formatNumber } from '../../lib/format';
import { FINANCE_CONNECTION_KEY, FINANCE_KEY, financeApi } from './api';
import { FINANCE_GUIDE_PATH, GuideSteps } from './FinanceGuide';

const TOKEN_RE = /^[A-Za-z0-9]{16,128}$/;
const LAST4_RE = /^\d{4}$/;
const TITLES = ['Trước khi liên kết', 'Lấy token trên thueapibank.vn', 'Dán token vào app'];

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called after a successful link (e.g. to navigate to /finance). */
  onLinked?: () => void;
}

/**
 * Self-service linking (each person registers on thueapibank.vn themselves):
 * 1. consent (what the app stores, the bank-account risk), 2. step-by-step guide, 3. paste token + last 4 digits.
 * The bank password is typed on thueapibank.vn only; this app never asks for it.
 */
export function LinkBankWizard({ open, onClose, onLinked }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [agreed, setAgreed] = useState(false);
  const [token, setToken] = useState('');
  const [last4, setLast4] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setAgreed(false);
    setToken('');
    setLast4('');
    setError(null);
  }, [open]);

  const link = useMutation({
    mutationFn: () => financeApi.link(token, last4),
    onSuccess: async (r) => {
      qc.setQueryData(FINANCE_CONNECTION_KEY, r.connection);
      toast.success(
        `Đã liên kết MBBank ••${r.connection.accountLast4}` + (r.imported ? ` · nhập ${formatNumber(r.imported)} giao dịch` : ''),
      );
      onClose();
      onLinked?.();
      await qc.invalidateQueries({ queryKey: FINANCE_KEY });
    },
    onError: (err) => setError(err instanceof ApiRequestError ? err.message : 'Có lỗi xảy ra, thử lại nhé.'),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    link.mutate();
  }

  const tokenOk = TOKEN_RE.test(token);
  const last4Ok = LAST4_RE.test(last4);

  return (
    <BottomSheet open={open} onClose={onClose} title={TITLES[step]}>
      <div className="form">
        <div className="stepper stepper--brand" aria-label={`Bước ${step + 1} / 3`}>
          {TITLES.map((t, i) => (
            <span key={t} className={`stepper__dot${i <= step ? ' is-done' : ''}`} />
          ))}
        </div>

        {step === 0 && (
          <>
            <ul className="bullets">
              <li>
                App đọc lịch sử giao dịch MBBank qua <strong>thueapibank.vn</strong>, một dịch vụ bên thứ ba,
                không phải ngân hàng và không phải đối tác chính thức của MB.
              </li>
              <li>
                Bạn nhập mật khẩu MBBank trên thueapibank.vn. <strong>App không bao giờ hỏi mật khẩu ngân hàng.</strong>
              </li>
              <li>
                Theo điều khoản của thueapibank, việc đăng nhập tự động có thể khiến tài khoản MB bị khóa tạm thời
                hoặc phải xác thực lại, và họ không bồi thường.
              </li>
              <li>
                App chỉ lưu <strong>số tiền, tiền vào hay ra và thời gian</strong>. Không lưu nội dung chuyển khoản,
                số dư hay số tài khoản.
              </li>
              <li>
                Mặc định <strong>chỉ bạn xem</strong>. Bạn có thể cho người ấy xem, ngắt kết nối và xóa dữ liệu bất cứ lúc nào.
              </li>
            </ul>
            <label className="check">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
              <span>Tôi đã hiểu và đồng ý</span>
            </label>
            <button type="button" className="btn btn-primary btn-lg btn-block" disabled={!agreed} onClick={() => setStep(1)}>
              Tiếp tục
            </button>
          </>
        )}

        {step === 1 && (
          <>
            <GuideSteps withAppStep={false} />
            <Link to={FINANCE_GUIDE_PATH} className="text-link" onClick={onClose}>
              Xem hướng dẫn đầy đủ và câu hỏi thường gặp
            </Link>
            <div className="btn-row">
              <button type="button" className="btn btn-outline" onClick={() => setStep(0)}>
                Quay lại
              </button>
              <button type="button" className="btn btn-primary" onClick={() => setStep(2)}>
                Tôi đã có token
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <form className="form" onSubmit={onSubmit}>
            <label className="field">
              <span className="field__label">Token MBBank trên thueapibank</span>
              <input
                className="input mono"
                value={token}
                onChange={(e) => setToken(e.target.value.replace(/\s/g, ''))}
                placeholder="Dán chuỗi ở cột TOKEN"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={128}
                required
              />
              <span className="field__hint">Đây không phải mật khẩu ngân hàng. Không dán mật khẩu vào đây.</span>
            </label>
            <label className="field">
              <span className="field__label">4 số cuối số tài khoản MB</span>
              <input
                className="input num"
                value={last4}
                onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
                inputMode="numeric"
                placeholder="VD: 9999"
                autoComplete="off"
                required
              />
              <span className="field__hint">Chỉ để bạn nhận ra tài khoản trong app.</span>
            </label>
            {error && (
              <p className="form-error" role="alert">
                <Icon name="alert" size={18} />
                {error}
              </p>
            )}
            <div className="btn-row">
              <button type="button" className="btn btn-outline" onClick={() => setStep(1)} disabled={link.isPending}>
                Quay lại
              </button>
              <button type="submit" className="btn btn-primary" disabled={!tokenOk || !last4Ok || link.isPending}>
                {link.isPending ? <span className="spinner" aria-hidden="true" /> : null}
                {link.isPending ? 'Đang kiểm tra…' : 'Liên kết'}
              </button>
            </div>
            {link.isPending && <p className="text-sm text-muted center">Đang kiểm tra token với thueapibank, mất vài giây…</p>}
          </form>
        )}
      </div>
    </BottomSheet>
  );
}
