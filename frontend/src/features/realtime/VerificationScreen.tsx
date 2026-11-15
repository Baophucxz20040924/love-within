import './VerificationScreen.css';

export interface VerificationScreenProps {
  status: 'checking' | 'failed';
  onRetry: () => void;
}

/** A neutral holding screen while access to the private space is verified. */
export function VerificationScreen({ status, onRetry }: VerificationScreenProps) {
  const checking = status === 'checking';

  return (
    <main className="verification-screen">
      <section className="verification-screen__card" aria-labelledby="verification-screen-title">
        <div className="verification-screen__brand" aria-label="Love Within">
          <span className="verification-screen__brand-mark" aria-hidden="true">♥</span>
          <span>Love Within</span>
        </div>

        <div className="verification-screen__illustration" aria-hidden="true">
          <div className="verification-screen__icon">
            <svg viewBox="0 0 48 48" fill="none">
              <path d="M24 5.5 38 11v10.7c0 9-5.5 16.1-14 20.8-8.5-4.7-14-11.8-14-20.8V11L24 5.5Z" fill="currentColor" fillOpacity=".08" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
              <path d="M24 30.8s-6.8-4.3-6.8-9.1a3.8 3.8 0 0 1 6.8-2.4 3.8 3.8 0 0 1 6.8 2.4c0 4.8-6.8 9.1-6.8 9.1Z" fill="currentColor" />
            </svg>
          </div>
          {checking && <span className="verification-screen__spinner" />}
        </div>

        <div className="verification-screen__copy" role="status" aria-live="polite" aria-atomic="true">
          <h1 id="verification-screen-title">{checking ? 'Đang kết nối lại' : 'Chưa thể kết nối lại'}</h1>
          <p>
            {checking
              ? 'Đang kiểm tra lại quyền truy cập. Chờ một chút nhé.'
              : 'Không gian riêng đang được tạm ẩn khi chưa thể xác minh quyền truy cập. Vui lòng thử lại nhé.'}
          </p>
        </div>

        {!checking && (
          <button type="button" className="verification-screen__retry" onClick={onRetry}>
            Thử lại
          </button>
        )}
      </section>
    </main>
  );
}
