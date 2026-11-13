import { useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Icon, type IconName } from '../components/Icon';
import { Page } from '../components/StatusViews';
import { useToast } from '../components/Toast';
import { useAuth } from '../features/auth/AuthContext';
import { detectDevice, isStandalone, promptInstall, useInstallState } from '../lib/installPrompt';
import { homeOf } from '../lib/spaceStore';

/** A button of the browser drawn inline in the text ("Chạm [⬆]"). */
function Key({ icon }: { icon: IconName }) {
  return (
    <span className="key-hint" aria-hidden="true">
      <Icon name={icon} size={16} />
    </span>
  );
}

function AppTile() {
  return (
    <span className="install-shot install-shot--app" aria-hidden="true">
      <img src="/icons/icon-192.png" alt="" width={48} height={48} className="install-shot__icon" />
      <span>Look Within</span>
    </span>
  );
}

function IosGuide({ notSafari }: { notSafari: boolean }) {
  return (
    <section className="card stack" aria-labelledby="install-ios">
      <h2 id="install-ios" className="card__title">
        iPhone, iPad (Safari)
      </h2>
      {notSafari && (
        <p className="callout" role="note">
          <Icon name="alert" size={18} />
          <span>Mở trang này bằng Safari để cài app chắc chắn nhất.</span>
        </p>
      )}
      <ol className="steps install-steps">
        <li>
          <span className="install-step">
            <span>
              Chạm nút <strong>Chia sẻ</strong> <Key icon="share" /> ở thanh dưới của Safari (iPad: góc trên). Trên iOS 26, chạm{' '}
              <Key icon="moreHorizontal" /> cạnh thanh địa chỉ rồi chọn <strong>Chia sẻ</strong>.
            </span>
            <span className="install-shot" aria-hidden="true">
              <Icon name="chevronLeft" size={20} />
              <Icon name="chevronRight" size={20} />
              <span className="install-shot__target">
                <Icon name="share" size={18} />
              </span>
              <Icon name="bookOpen" size={20} />
            </span>
          </span>
        </li>
        <li>
          <span className="install-step">
            <span>
              Kéo xuống, chọn <strong>Thêm vào MH chính</strong> <Key icon="plusSquare" />, rồi chạm <strong>Thêm</strong>.
            </span>
            <span className="install-shot install-shot--row" aria-hidden="true">
              <span>Thêm vào MH chính</span>
              <Icon name="plusSquare" size={20} />
            </span>
          </span>
        </li>
        <li>
          <span className="install-step">
            <span>
              Mở <strong>Look Within</strong> từ biểu tượng mới trên màn hình chính.
            </span>
            <AppTile />
          </span>
        </li>
      </ol>
      <p className="callout" role="note">
        <Icon name="lock" size={18} />
        <span>
          App trên màn hình chính không dùng chung đăng nhập với Safari. Lần đầu mở app, bạn cần đăng nhập lại một lần.
        </span>
      </p>
    </section>
  );
}

function AndroidGuide({ withButton }: { withButton: boolean }) {
  return (
    <section className="card stack" aria-labelledby="install-android">
      <h2 id="install-android" className="card__title">
        Android (Chrome)
      </h2>
      {withButton && <p className="text-sm text-muted">Không thấy hộp cài đặt khi bấm "Cài app"? Làm theo các bước sau.</p>}
      <ol className="steps install-steps">
        <li>
          <span>
            Chạm <Key icon="moreVertical" /> ở góc trên bên phải Chrome.
          </span>
        </li>
        <li>
          <span>
            Chọn <strong>Cài đặt ứng dụng</strong> (hoặc <strong>Thêm vào màn hình chính</strong>), rồi chạm <strong>Cài đặt</strong>.
          </span>
        </li>
        <li>
          <span className="install-step">
            <span>
              Mở <strong>Look Within</strong> từ màn hình chính.
            </span>
            <AppTile />
          </span>
        </li>
      </ol>
    </section>
  );
}

/**
 * /install — public (no login). How to add Look Within to the home screen: Share → "Thêm vào MH chính" on iPhone/iPad,
 * the browser's install prompt (beforeinstallprompt, captured in main.tsx) or the ⋮ menu on Android, "Bạn đang dùng app"
 * when already running as the installed app. Same page and words for every session: nothing here names another space.
 */
export function InstallPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const { isAuthenticated, space } = useAuth();
  const { canPrompt, installed } = useInstallState();
  const [standalone] = useState(isStandalone);
  const device = useMemo(() => detectDevice(), []);
  const [busy, setBusy] = useState(false);

  const home = isAuthenticated ? homeOf(space) : '/login';
  // Opened from a link in the app: go back there; opened directly: go to the start page.
  const goBack = () => (location.key !== 'default' ? navigate(-1) : navigate(home, { replace: true }));

  async function onInstall() {
    setBusy(true);
    try {
      const outcome = await promptInstall();
      if (outcome === 'accepted') toast.success('Đang cài Look Within lên máy');
    } catch {
      toast.error('Không mở được hộp cài đặt. Dùng menu ⋮ của trình duyệt nhé.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <main className="app-content app-content--bare">
        <Page title="Cài app lên điện thoại" subtitle="Mở Look Within như một ứng dụng" onBack={goBack} bell={false}>
          {standalone ? (
            <div className="card stack center install-done">
              <span className="icon-tile icon-tile--success install-done__icon" aria-hidden="true">
                <Icon name="check" />
              </span>
              <h2 className="card__title">Bạn đang dùng app</h2>
              <p className="text-muted">Look Within đã có trên màn hình chính của máy này. Lần sau, mở app từ biểu tượng đó.</p>
              <Link to={home} replace className="btn btn-primary btn-lg btn-block">
                {isAuthenticated ? 'Về trang chính' : 'Đăng nhập'}
              </Link>
            </div>
          ) : (
            <>
              <div className="card install-intro">
                <img src="/icons/icon-192.png" alt="" width={56} height={56} className="install-intro__icon" />
                <p>Thêm Look Within vào màn hình chính để mở bằng một chạm, toàn màn hình như ứng dụng. Không cần tải từ App Store hay CH Play.</p>
              </div>

              {device.inApp && (
                <p className="callout" role="note">
                  <Icon name="alert" size={18} />
                  <span>
                    Bạn đang mở trang này trong một ứng dụng khác (Zalo, Facebook…). Chạm <strong>⋯</strong> hoặc <strong>⋮</strong>, chọn mở
                    bằng trình duyệt (Safari hoặc Chrome), rồi làm theo hướng dẫn.
                  </span>
                </p>
              )}

              {installed && (
                <p className="callout install-ok" role="status">
                  <Icon name="check" size={18} />
                  <span>Đã cài Look Within. Mở app từ màn hình chính.</span>
                </p>
              )}

              {canPrompt && (
                <button type="button" className="btn btn-primary btn-lg btn-block" onClick={onInstall} disabled={busy}>
                  {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="download" size={18} />}
                  Cài app
                </button>
              )}

              {device.platform === 'ios' && <IosGuide notSafari={device.iosNotSafari} />}
              {device.platform === 'android' && <AndroidGuide withButton={canPrompt} />}
              {device.platform === 'other' && (
                <>
                  <p className="text-sm text-muted">Mở trang này trên điện thoại rồi làm theo hướng dẫn cho máy của bạn.</p>
                  <IosGuide notSafari={false} />
                  <AndroidGuide withButton={canPrompt} />
                </>
              )}
            </>
          )}
        </Page>
      </main>
    </div>
  );
}
