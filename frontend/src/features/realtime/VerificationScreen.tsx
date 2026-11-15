import { Icon } from '../../components/Icon';
import './VerificationScreen.css';

interface VerificationScreenProps {
  state: 'checking' | 'failed';
  onRetry: () => void;
}

/** A neutral screen while access is being verified, independent of the current space. */
export function VerificationScreen({ state, onRetry }: VerificationScreenProps) {
  const checking = state === 'checking';

  return (
    <main className="verification-screen" aria-busy={checking}>
      <div className="verification-screen__ambient" aria-hidden="true" />
      <section className="verification-screen__card">
        <div className="verification-screen__brand"><Icon name="heart" size={17} /> <span>Love Within</span></div>
        <div className={`verification-screen__emblem${checking ? ' verification-screen__emblem--checking' : ''}`} aria-hidden="true">
          <Icon name="shield" size={44} strokeWidth={1.5} />
          <span className="verification-screen__heart"><Icon name="heart" size={19} strokeWidth={2} /></span>
        </div>
        <div role="status" aria-live="polite" aria-atomic="true">
          <p className="verification-screen__eyebrow">MỘT CHÚT NHÉ</p>
          <h1>{checking ? 'Đang kiểm tra quyền truy cập' : 'Chưa thể kiểm tra quyền truy cập'}</h1>
          <p className="verification-screen__description">
            {checking ? 'Love đang kiểm tra lại để bạn có thể tiếp tục.' : 'Vui lòng kiểm tra kết nối và thử lại nhé.'}
          </p>
        </div>
        {checking ? (
          <div className="verification-screen__loading" aria-hidden="true"><span /><span /><span /></div>
        ) : (
          <button type="button" className="verification-screen__retry" onClick={onRetry}>
            <Icon name="refresh" size={17} /> Thử lại
          </button>
        )}
      </section>
    </main>
  );
}
